// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — error-class-aware fallback (replaces lossy `isRetryableProviderError`).
 *
 * Maps a thrown error to a concrete class + recommended action.
 * Auth class also queues an ops event (placeholder in Phase 2; wired in Phase 5).
 */

export type ErrorClass =
    | 'rate-limit'
    | 'auth'
    | 'context-window'
    | 'content-policy'
    | 'transient-5xx'
    | 'network'
    | 'quota'
    | 'parse-malformed'
    | 'empty-output'
    | 'unknown-4xx'
    | 'unknown'

export type SuggestedAction =
    | 'retry-same'
    | 'fallback-next'
    | 'surface-auth-badge'
    | 'fail-hard'

export interface Classification {
    class: ErrorClass
    shouldFallback: boolean
    suggestedAction: SuggestedAction
    /** Parsed retry-after if the provider gave one. Always ms. */
    retryAfterMs?: number
}

const opsEventQueue: Array<{ event: string; payload: Record<string, unknown>; at: number }> = []

/** Test-only — read pending ops events queued by the classifier. */
export function _drainOpsEventQueueForTest(): typeof opsEventQueue {
    const copy = [...opsEventQueue]
    opsEventQueue.length = 0
    return copy
}

function queueOpsEvent(event: string, payload: Record<string, unknown>): void {
    opsEventQueue.push({ event, payload, at: Date.now() })
    // TODO(Phase 5): replace with real telemetry sink emit
    console.info(JSON.stringify({ event, ...payload }))
}

/**
 * Remove URLs before substring classification. Provider messages embed
 * marketing/help links whose PATHS contain classification keywords — e.g.
 * groq's daily-cap 429 ends with "Need more tokens? Upgrade to Dev Tier today
 * at https://console.groq.com/settings/billing", where 'billing' would
 * otherwise read as funds depletion. Words inside a URL are the provider
 * pointing at a page, not describing the error.
 */
function stripUrls(msg: string): string {
    return msg.replace(/https?:\/\/[^\s"')\]}>]+/gi, ' ')
}

function parseRetryAfterMs(msg: string): number | undefined {
    const m = msg.match(/retry[- ]after[:\s]*(\d+(?:\.\d+)?)/i)
    if (!m) return undefined
    const v = parseFloat(m[1]!)
    return v < 100 ? v * 1000 : v
}

/**
 * Classify a thrown error into one of 8 classes.
 * Expanded from `registry.ts:928` (`isRetryableProviderError`) — the prior
 * version collapsed everything into retryable:yes/no, losing branch info.
 */
export function classifyError(err: unknown): Classification {
    if (!(err instanceof Error)) {
        return { class: 'unknown', shouldFallback: false, suggestedAction: 'fail-hard' }
    }
    // Caller-signaled non-fallback sentinel: the chat stream handler throws this
    // AFTER partial output has already been delivered to the client, so the router
    // must NOT cascade (a re-call would re-stream from the start and duplicate what
    // the client already received). Treated as a hard, non-advancing failure.
    if (err.name === 'StreamPartialAbortError') {
        return { class: 'unknown', shouldFallback: false, suggestedAction: 'fail-hard' }
    }
    const msg = stripUrls(err.message).toLowerCase()
    const retryAfterMs = parseRetryAfterMs(err.message)

    // Auth — surface to operator, advance silently to next provider.
    if (
        msg.includes('invalid api key') ||
        msg.includes('invalid_api_key') ||
        msg.includes('incorrect api key') ||
        msg.includes('unauthorized') ||
        msg.includes('authentication failed') ||
        msg.includes('authentication_error') ||
        msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('forbidden')
    ) {
        queueOpsEvent('provider.auth_failed', { message: err.message.slice(0, 200) })
        return { class: 'auth', shouldFallback: true, suggestedAction: 'surface-auth-badge' }
    }

    // Quota — billing or hard cap. Surface, do not retry same; advance.
    // 'insufficient balance' matches DeepSeek's exact wording when an account
    // runs out of credits ("AI_APICallError: Insufficient Balance" at HTTP 402).
    // Without this match the error fell through to 'unknown' (shouldFallback=false),
    // which short-circuited the cascade and stuck production for ~6 days.
    if (
        msg.includes('quota') ||
        msg.includes('insufficient_quota') ||
        msg.includes('insufficient balance') ||
        msg.includes('insufficient_balance') ||
        msg.includes('billing') ||
        msg.includes('credit balance') ||
        // Word boundary (like the /\b500\b/ precedent below): a bare
        // includes('402') matches token counts such as "Used 140250".
        /\b402\b/.test(msg)
    ) {
        return { class: 'quota', shouldFallback: true, suggestedAction: 'fallback-next' }
    }

    // Rate-limit — advance after retry-after.
    if (
        msg.includes('rate limit') ||
        msg.includes('429') ||
        msg.includes('too many requests')
    ) {
        return { class: 'rate-limit', shouldFallback: true, suggestedAction: 'fallback-next', retryAfterMs }
    }

    // Context window exceeded — must advance to a model with larger context.
    if (
        msg.includes('context length') ||
        msg.includes('context window') ||
        msg.includes('maximum context') ||
        msg.includes('too long') ||
        msg.includes('context_length_exceeded')
    ) {
        return { class: 'context-window', shouldFallback: true, suggestedAction: 'fallback-next' }
    }

    // Network — DNS / refused / reset / unreachable. Match BEFORE content-policy
    // so that ECONNREFUSED isn't swallowed by the looser 'refused' keyword.
    if (
        msg.includes('enotfound') ||
        msg.includes('ehostunreach') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('socket hang up') ||
        msg.includes('network error') ||
        msg.includes('fetch failed') ||
        msg.includes('cannot connect') ||
        // A dead / removed endpoint (410 Gone, 404 Not Found) must cascade to
        // another candidate rather than fail hard — e.g. a decommissioned local
        // model URL. Treated as network-class so the workspace advances.
        msg.includes('410') ||
        msg.includes('gone') ||
        msg.includes('404') ||
        msg.includes('not found')
    ) {
        return { class: 'network', shouldFallback: true, suggestedAction: 'fallback-next' }
    }

    // Transient server errors — advance + count toward circuit-breaker.
    // Bare 500 (Internal Server Error) belongs here too: without it a provider
    // 500 fell through to 'unknown' (shouldFallback=false) and dead-ended the
    // cascade instead of trying the next provider. Matched with a word boundary
    // (/\b500\b/) rather than includes('500') so it doesn't collide with token
    // counts / latencies like "1500", "5000", or "500ms".
    if (
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('529') ||
        /\b500\b/.test(msg) ||
        msg.includes('internal server error') ||
        msg.includes('overloaded') ||
        msg.includes('bad gateway') ||
        msg.includes('gateway timeout') ||
        msg.includes('service unavailable') ||
        msg.includes('timeout')
    ) {
        return { class: 'transient-5xx', shouldFallback: true, suggestedAction: 'fallback-next' }
    }

    // Aborted / timed-out attempt — the per-attempt deadline (AbortSignal.timeout
    // in the caller's doCall) fired, which the AI SDK surfaces as
    // "AbortError: Delay was aborted" from its internal retry `delay()`, or as a
    // DOMException named 'TimeoutError'. The message carries no 5xx / 'timeout'
    // keyword, so without this branch it fell through to 'unknown'
    // (shouldFallback=false) and DEAD-ENDED the cascade — the exact bug that let a
    // slow provider (cerebras, p95≈30s) kill completions instead of failing over
    // to a healthy candidate (e.g. ollama_cloud). Treat as transient so the router
    // cools the slow candidate and advances. NOTE: a deliberate user-cancel also
    // aborts, but the chat/stream handler tears down the whole response on cancel
    // and never re-enters the cascade, so advancing here only affects the
    // deadline-driven aborts we want to fail over.
    if (
        err.name === 'AbortError' ||
        err.name === 'TimeoutError' ||
        msg.includes('was aborted') ||
        msg.includes('operation was aborted') ||
        msg.includes('the operation timed out')
    ) {
        return { class: 'transient-5xx', shouldFallback: true, suggestedAction: 'fallback-next' }
    }

    // Content policy refusal — provider returned a refusal; advance, do not
    // penalize the model (legitimate provider behavior).
    if (
        msg.includes('content policy') ||
        msg.includes('content_policy') ||
        msg.includes('safety') ||
        msg.includes('refused') ||
        msg.includes('blocked by safety') ||
        msg.includes('responsibleai')
    ) {
        return { class: 'content-policy', shouldFallback: true, suggestedAction: 'fallback-next' }
    }

    // Empty / failed stream — the model produced NO output at all
    // (AI_NoOutputGeneratedError: "No output generated. Check the stream for
    // errors."). This is transient: a re-call of the SAME model usually
    // succeeds, so retry in place first (keeps a single-provider workspace
    // resilient) — the router only advances to another model after retries.
    if (
        msg.includes('no output generated') ||
        msg.includes('nooutputgenerated') ||
        msg.includes('empty response') ||
        msg.includes('empty completion') ||
        msg.includes('no output from')
    ) {
        return { class: 'empty-output', shouldFallback: true, suggestedAction: 'retry-same' }
    }

    // Malformed STRUCTURED output OR a provider rejecting the response_format
    // schema. Two sub-cases, same handling (advance to another provider):
    //   1. The model couldn't emit valid JSON/schema (AI_NoObjectGeneratedError,
    //      one word apart from the empty-output case above) — a capability gap.
    //   2. The provider REJECTED the request schema as invalid for ITS stricter
    //      validator (e.g. groq: "invalid JSON schema for response_format ...
    //      `additionalProperties:false` must be set on every object"), while a
    //      more lenient provider (cerebras/ollama_cloud, same model) accepts it.
    // Both are non-transient for the SAME model, so use fallback-next (NOT
    // retry-same): the router cools this provider and advances to the next
    // candidate. Bounded by MAX_CASCADE + per-candidate cooldown — a genuinely
    // malformed schema that every provider rejects walks the candidates once and
    // then cascade-exhausts rather than looping.
    if (
        msg.includes('call_model_parse') ||
        msg.includes('json parsing failed') ||
        msg.includes('no object generated') ||
        msg.includes('json_schema') ||
        msg.includes('json schema') ||
        msg.includes('response format') ||
        msg.includes('response_format') ||
        msg.includes('additionalproperties') ||
        msg.includes('invalid schema') ||
        msg.includes('structured')
    ) {
        return { class: 'parse-malformed', shouldFallback: true, suggestedAction: 'fallback-next' }
    }

    // Generic provider request rejection — an HTTP 400 (or a bare "Bad Request")
    // that the provider returned for THIS request/model. It falls through every
    // branch above to the fail-hard tail, which DEAD-ENDS the cascade: the whole
    // task fails even though another provider would have served it. That is the
    // exact bug behind a plain "Write me a joke" returning E_UNKNOWN when the
    // router happened to pick a provider that 400'd. Treat as fallback-next — a
    // provider-specific rejection is not a client-wide fault. Matched LAST (after
    // the specific 4xx classes above) and by status token only, so auth/quota/
    // rate-limit/context/parse keep their more precise handling.
    if (
        /\b400\b/.test(msg) ||
        msg.includes('bad request') ||
        msg.includes('invalid_request_error') ||
        msg.includes('invalid request')
    ) {
        return { class: 'unknown-4xx', shouldFallback: true, suggestedAction: 'fallback-next' }
    }

    // Anything else — caller error or model produced bad output; do not advance.
    return { class: 'unknown', shouldFallback: false, suggestedAction: 'fail-hard' }
}

/**
 * Backwards-compat helper for callers that still want a yes/no answer.
 * Equivalent semantics to `registry.ts:928` `isRetryableProviderError`.
 */
export function shouldFallbackFromError(err: unknown): boolean {
    return classifyError(err).shouldFallback
}

/**
 * Hard funds-depletion subset of the 'quota' class — the durable "add money to
 * fix" states only. Triggers a PERSISTENT pull (provider excluded until the
 * operator dismisses the notice), so the signature must be unambiguous.
 *
 * Deliberately NOT matched: a bare `insufficient_quota` token. It is ambiguous —
 * OpenAI uses it for genuine billing exhaustion, but OpenAI-compatible providers
 * like Groq reuse the same error envelope for a DAILY token cap (TPD) that
 * resets on its own. A daily cap must NOT persist-pull (it would exclude a
 * provider that recovers at the next reset); it falls through to the normal
 * 'quota'/'rate-limit' cooldown instead. Genuine OpenAI billing exhaustion still
 * matches here because its message also carries "billing" ("check your plan and
 * billing details"); deepseek's "Insufficient Balance" and any HTTP 402 match
 * too. Net: only unambiguous funds depletion gets the durable pull.
 *
 * Two additional guards, both learned from groq's free-tier daily-cap 429
 * ("Rate limit reached ... tokens per day (TPD) ... Please try again in 9m38s.
 * Need more tokens? Upgrade to Dev Tier today at
 * https://console.groq.com/settings/billing"):
 *   1. URLs are stripped before matching — 'billing' inside a help link is the
 *      provider pointing at a page, not describing the error.
 *   2. A message carrying rate-limit signatures is NEVER funds depletion,
 *      whatever upsell copy rides along; it recovers on its own and must not
 *      persist-pull the provider.
 */
export function isBalanceExhaustedError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    const msg = stripUrls(err.message).toLowerCase()
    if (
        msg.includes('rate limit') ||
        msg.includes('429') ||
        msg.includes('too many requests') ||
        msg.includes('tokens per day') ||
        msg.includes('tokens per minute') ||
        msg.includes('tpd') ||
        msg.includes('tpm') ||
        msg.includes('try again in')
    ) {
        return false
    }
    return (
        msg.includes('insufficient balance') ||
        msg.includes('insufficient_balance') ||
        msg.includes('credit balance') ||
        msg.includes('billing') ||
        /\b402\b/.test(msg)
    )
}
