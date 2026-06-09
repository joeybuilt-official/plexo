// SPDX-License-Identifier: AGPL-3.0-only
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
    const msg = err.message.toLowerCase()
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
        msg.includes('402')
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
        msg.includes('cannot connect')
    ) {
        return { class: 'network', shouldFallback: true, suggestedAction: 'fallback-next' }
    }

    // Transient server errors — advance + count toward circuit-breaker.
    if (
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('529') ||
        msg.includes('overloaded') ||
        msg.includes('bad gateway') ||
        msg.includes('gateway timeout') ||
        msg.includes('service unavailable') ||
        msg.includes('timeout')
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
 * fix" states, distinct from a daily/per-minute rate cap (which resets on its
 * own and classifies as 'rate-limit'). Used to persist a provider as
 * balance-exhausted and surface a site-wide notice, so a dead primary (e.g. an
 * out-of-credit deepseek returning "Insufficient Balance" at HTTP 402) is pulled
 * from the routing chain instead of being re-tried every cooldown cycle.
 */
export function isBalanceExhaustedError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    const msg = err.message.toLowerCase()
    return (
        msg.includes('insufficient balance') ||
        msg.includes('insufficient_balance') ||
        msg.includes('insufficient_quota') ||
        msg.includes('insufficient quota') ||
        msg.includes('credit balance') ||
        msg.includes('billing') ||
        msg.includes('402')
    )
}
