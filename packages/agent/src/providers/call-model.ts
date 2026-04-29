// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * `callModel` — thin shared wrapper around the Vercel AI SDK's
 * `generateText` / `generateObject`. Phase 3 + Phase 4 of the
 * intelligence-hardening plan.
 *
 * What this helper owns:
 *   - AbortSignal composition (caller signal + per-step wall-clock
 *     timeout from Phase 2's EXECUTOR_STEP_TIMEOUT_MS env, default 180s)
 *   - Retry on transient errors (network, 5xx, 429). Max 2 attempts,
 *     500ms → 1500ms backoff. NO retry on 4xx-except-429 or AbortError.
 *   - Cost-gate pre-check via `assertAgentCostCeilingOk` — ONLY when
 *     `workspaceId` + `enforceCostCeiling: true` are both set.
 *   - Token-accounting pino log after success.
 *   - Typed error bubble-up: wraps inner failures in `CallModelError`
 *     with one of 6 sentinel codes (`CALL_MODEL_ABORTED`,
 *     `CALL_MODEL_TIMEOUT`, `CALL_MODEL_4XX`, `CALL_MODEL_5XX`,
 *     `CALL_MODEL_PARSE`, `CALL_MODEL_UNKNOWN`). `CostCeilingExceededError`
 *     is re-thrown unchanged so the executor's catch can still 402 cleanly.
 *   - Optional structured output: when `schema` is supplied, the helper
 *     routes to `generateObject` and the returned `CallModelObjectResult.object`
 *     is typed via `z.infer<typeof schema>`. Parse/validation failures
 *     surface as `CALL_MODEL_PARSE`.
 *
 * What this helper does NOT own:
 *   - Model resolution. Caller passes an already-resolved `AnyLanguageModel`.
 *     `IntelligentRouter` / `chain-resolver` stay authoritative above.
 *   - `streamText`. Text only. Streaming stays on the executor's direct call
 *     for the chat hot path until a future phase.
 *   - Per-model quirk normalization (Anthropic tool mode, Gemini safety,
 *     deepseek-reasoner chain-of-thought delay). Future commits as needed.
 *
 * Sister modules: `cost-gate.ts`, `chain-resolver.ts`. Same sub-module
 * layout convention inside `packages/agent/src/`.
 */

/* eslint-disable @typescript-eslint/no-deprecated -- generateText+Output migration is a separate phase; generateObject is still the supported structured-output entry point in ai@6 */
import { generateText, generateObject, NoObjectGeneratedError } from 'ai'
/* eslint-enable @typescript-eslint/no-deprecated */
import type { ZodType } from 'zod'
import pino from 'pino'
// CoreMessage isn't re-exported by current @ai-sdk/ai versions; accept
// the conservative shape the call sites actually use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider-varied
type CoreMessage = any
import {
    assertAgentCostCeilingOk,
    CostCeilingExceededError,
} from '../cost-gate.js'
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- model shape varies by provider
type AnyLanguageModel = any

const logger = pino({ name: 'call-model' })

// Stabilization: optional hook for metrics collection. Set by the API layer
// at startup to emit provider-level latency histograms. The agent package
// doesn't import the API's metrics module — this callback bridges them.
export type LlmCallMetrics = {
    provider: string
    model: string
    taskType: string
    status: 'success' | 'error'
    latencySec: number
}
let _onCallComplete: ((m: LlmCallMetrics) => void) | null = null
export function setLlmCallMetricsHook(fn: (m: LlmCallMetrics) => void): void {
    _onCallComplete = fn
}

// ── Types ─────────────────────────────────────────────────────────────

export interface CallModelOpts<T = unknown> {
    model: AnyLanguageModel
    system?: string
    /** Either `messages` OR `prompt` — pass whichever the call site already uses. */
    messages?: CoreMessage[]
    prompt?: string
    tools?: Record<string, unknown>
    /** Max output tokens. Forwarded as both `maxTokens` and `maxOutputTokens` so SDK version variance doesn't bite. */
    maxTokens?: number
    /** Caller's AbortSignal. Composed with the wall-clock step timeout. */
    signal?: AbortSignal
    /** Workspace id — required for cost-gate. */
    workspaceId?: string
    /** Task type — used for the cost-gate log + future per-task quirk handling. */
    taskType?: string
    /** Provider key (e.g. 'anthropic', 'openai') — used for latency metrics. */
    provider?: string
    /** When true AND workspaceId is set, runs `assertAgentCostCeilingOk` before the call. */
    enforceCostCeiling?: boolean
    /** Override the env wall-clock step timeout. Default EXECUTOR_STEP_TIMEOUT_MS || 180s. */
    stepTimeoutMs?: number
    /**
     * Optional Zod schema. When supplied, `callModel` routes through
     * `generateObject` instead of `generateText` and the SDK validates
     * the response against the schema (with its own parse-retry loop
     * at `maxRetries: 2`). Parse / validation failures surface as
     * `CallModelError` with `code: CALL_MODEL_PARSE`.
     *
     * Incompatible with `tools`: `generateObject` does not accept a tool
     * set. Passing both throws `CALL_MODEL_PARSE` at argument-validation
     * time — callers must pick one mode.
     */
    schema?: ZodType<T>
    /**
     * Optional schema name forwarded to `generateObject` — some providers
     * (OpenAI Responses, Anthropic tool-calling) use it as the tool name
     * for the underlying structured-output transport.
     */
    schemaName?: string
    /**
     * Optional schema description forwarded to `generateObject`.
     */
    schemaDescription?: string
}

interface CallModelResultBase {
    inputTokens: number
    outputTokens: number
    latencyMs: number
    /** Model id string as reported by the SDK. */
    model: string
    /** Number of attempts the helper made (1 = no retry, 2 = retried once). */
    attempts: number
}

/** Result shape for the text-mode call (no `schema` option). */
export interface CallModelResult extends CallModelResultBase {
    text: string
}

/**
 * Result shape for the schema-mode call (with `schema` option).
 * `object` is the parsed + Zod-validated structured output.
 * `text` is kept for token-accounting log parity and empty for this mode.
 */
export interface CallModelObjectResult<T> extends CallModelResultBase {
    object: T
    /** Always '' in schema mode — the SDK returns an object directly. */
    text: string
}

export type CallModelErrorCode =
    | 'CALL_MODEL_ABORTED'
    | 'CALL_MODEL_TIMEOUT'
    | 'CALL_MODEL_4XX'
    | 'CALL_MODEL_5XX'
    | 'CALL_MODEL_PARSE'
    | 'CALL_MODEL_UNKNOWN'

/**
 * Typed error wrapping any inner failure from the underlying model call.
 * The `code` field is the signal the Phase 2 `agent-loop.ts` catch reads
 * when building the `blockTask` reason prefix.
 */
export class CallModelError extends Error {
    readonly code: CallModelErrorCode
    readonly cause?: unknown
    constructor(message: string, code: CallModelErrorCode, cause?: unknown) {
        super(message)
        this.name = 'CallModelError'
        this.code = code
        this.cause = cause
    }
}

// ── Internals ─────────────────────────────────────────────────────────

interface HttpishError {
    status?: number
    statusCode?: number
    name?: string
    message?: string
}

function isAbortError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const e = err as HttpishError
    return e.name === 'AbortError' || (typeof e.message === 'string' && /abort/i.test(e.message))
}

function extractStatus(err: unknown): number | null {
    if (!err || typeof err !== 'object') return null
    const e = err as HttpishError & { data?: { status?: number }; response?: { status?: number } }
    return (
        e.status
        ?? e.statusCode
        ?? e.data?.status
        ?? e.response?.status
        ?? null
    )
}

function isParseError(err: unknown): boolean {
    if (NoObjectGeneratedError.isInstance(err)) return true
    if (!err || typeof err !== 'object') return false
    const name = (err as { name?: string }).name ?? ''
    // ai SDK surfaces parse/validation failures with these error classes:
    return (
        name === 'NoObjectGeneratedError'
        || name === 'TypeValidationError'
        || name === 'JSONParseError'
        || name === 'ZodError'
    )
}

function classifyError(err: unknown, timedOut: boolean): CallModelErrorCode {
    if (timedOut) return 'CALL_MODEL_TIMEOUT'
    if (isAbortError(err)) return 'CALL_MODEL_ABORTED'
    if (isParseError(err)) return 'CALL_MODEL_PARSE'
    const status = extractStatus(err)
    if (status !== null) {
        if (status >= 400 && status < 500) return 'CALL_MODEL_4XX'
        if (status >= 500) return 'CALL_MODEL_5XX'
    }
    // Network-layer errors without a status
    const msg = err instanceof Error ? err.message : String(err ?? '')
    if (/ECONNRESET|ENOTFOUND|ETIMEDOUT|socket/i.test(msg)) return 'CALL_MODEL_5XX'
    return 'CALL_MODEL_UNKNOWN'
}

function isRetryable(err: unknown): boolean {
    if (isAbortError(err)) return false
    // generateObject has its own internal parse-retry loop (maxRetries: 2)
    // before throwing. Don't double-retry at the callModel layer.
    if (isParseError(err)) return false
    const status = extractStatus(err)
    if (status !== null) {
        if (status === 429) return true
        if (status >= 500) return true
        if (status >= 400) return false
    }
    // Network-layer errors without a status: retry
    const msg = err instanceof Error ? err.message : String(err ?? '')
    if (/ECONNRESET|ENOTFOUND|ETIMEDOUT|socket|fetch failed/i.test(msg)) return true
    return false
}

function backoffDelayMs(attempt: number): number {
    // attempt is 1-indexed (1 = first retry). 500ms, then 1500ms.
    return attempt === 1 ? 500 : 1500
}

// ── Fenced-JSON rescue ────────────────────────────────────────────────
// Some providers (notably ollama_cloud routed through @ai-sdk/openai-compatible
// without `structuredOutputs` support) return JSON wrapped in markdown code
// fences. The AI SDK's strict parser rejects that with NoObjectGeneratedError.
// Before surfacing CALL_MODEL_PARSE we try to recover: walk the error chain
// for the raw text, strip fences, JSON.parse, validate against the original
// zod schema. If the rescue succeeds we return the parsed object as if the
// SDK had succeeded — matching the original caller contract exactly.

function stripCodeFence(text: string): string | null {
    // First try: whole string is a single fenced block.
    const trimmed = text.trim()
    const whole = trimmed.match(/^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/)
    if (whole) return whole[1].trim()
    // Second try: first fenced block anywhere in the string (handles preamble/postamble).
    const inner = text.match(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```/)
    if (inner) return inner[1].trim()
    // Third try: first balanced JSON object or array. Cheap heuristic — find
    // the first '{' or '[' and the matching last '}' or ']'.
    const firstObj = text.indexOf('{')
    const lastObj = text.lastIndexOf('}')
    if (firstObj !== -1 && lastObj > firstObj) return text.slice(firstObj, lastObj + 1).trim()
    const firstArr = text.indexOf('[')
    const lastArr = text.lastIndexOf(']')
    if (firstArr !== -1 && lastArr > firstArr) return text.slice(firstArr, lastArr + 1).trim()
    return null
}

function extractRawText(err: unknown, depth = 0): string | null {
    if (depth > 5 || !err || typeof err !== 'object') return null
    const e = err as { text?: unknown; message?: unknown; cause?: unknown }
    if (typeof e.text === 'string' && e.text.length > 0) return e.text
    if (typeof e.message === 'string') {
        // AI_JSONParseError serializes the raw text into the message:
        //   "JSON parsing failed: Text: <raw>\nError message: ..."
        // The raw text may or may not end in '.', and may itself contain newlines.
        const m = e.message.match(/Text:\s*([\s\S]*?)\n\s*Error message:/)
        if (m && m[1]) return m[1]
    }
    if (e.cause) return extractRawText(e.cause, depth + 1)
    return null
}

function tryRescueFencedJson(
    err: unknown,
    schema: ZodType<unknown> | undefined,
): { object: unknown } | null {
    if (!isParseError(err)) return null
    const raw = extractRawText(err)
    if (!raw) return null
    const stripped = stripCodeFence(raw)
    if (!stripped) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(stripped)
    } catch {
        return null
    }
    if (schema) {
        const result = schema.safeParse(parsed)
        if (!result.success) return null
        return { object: result.data }
    }
    return { object: parsed }
}

// ── Public entry ──────────────────────────────────────────────────────

/**
 * Call an LLM with typed retry, abort composition, cost gating, and
 * token accounting. Replaces direct `generateText` / `generateObject`
 * calls at the migration sites.
 *
 * Overload 1 — text mode: returns `{ text: string, ...accounting }`.
 * Overload 2 — schema mode: returns `{ object: T, text: '', ...accounting }`.
 *              `T` is inferred from `opts.schema`.
 */
export async function callModel(opts: CallModelOpts & { schema?: undefined }): Promise<CallModelResult>
export async function callModel<T>(opts: CallModelOpts<T> & { schema: ZodType<T> }): Promise<CallModelObjectResult<T>>
export async function callModel(opts: CallModelOpts<unknown>): Promise<CallModelResult | CallModelObjectResult<unknown>> {
    // Argument-validation guard: generateObject does not accept a tool set,
    // so combining `schema` + `tools` is a misuse. Fail loudly and up-front
    // with CALL_MODEL_PARSE rather than let the SDK's error surface an
    // opaque provider-specific failure.
    if (opts.schema && opts.tools) {
        throw new CallModelError(
            'callModel: cannot combine `schema` and `tools` — generateObject does not support tool calls. Pick one.',
            'CALL_MODEL_PARSE',
        )
    }

    // Cost gate (optional, workspace-scoped)
    if (opts.enforceCostCeiling && opts.workspaceId) {
        // Re-throw CostCeilingExceededError unchanged so agent-loop's catch
        // picks up its `code` field and generates a [COST_CEILING_EXCEEDED]
        // prefix in the blockTask reason.
        await assertAgentCostCeilingOk(opts.workspaceId)
    }

    // Wall-clock timeout composition — matches Phase 2 executor behavior.
    const envTimeout = Number(process.env.EXECUTOR_STEP_TIMEOUT_MS) || 180_000
    const stepTimeoutMs = opts.stepTimeoutMs ?? envTimeout
    const signals: AbortSignal[] = [AbortSignal.timeout(stepTimeoutMs)]
    if (opts.signal) signals.unshift(opts.signal)
    const composedSignal = AbortSignal.any(signals)

    const schemaMode = opts.schema !== undefined

    let attempts = 0
    let lastErr: unknown = null

    while (attempts < 2) {
        attempts++
        const startedAt = Date.now()
        try {
            // Forward both maxTokens and maxOutputTokens so SDK version
            // variance doesn't bite. Callers can pass either; we spread
            // both aliases and the SDK ignores unknown fields.
            const genArgs: Record<string, unknown> = {
                model: opts.model,
                abortSignal: composedSignal,
            }
            if (opts.system !== undefined) genArgs.system = opts.system
            if (opts.messages !== undefined) genArgs.messages = opts.messages
            if (opts.prompt !== undefined) genArgs.prompt = opts.prompt
            if (!schemaMode && opts.tools !== undefined) genArgs.tools = opts.tools
            if (opts.maxTokens !== undefined) {
                genArgs.maxTokens = opts.maxTokens
                genArgs.maxOutputTokens = opts.maxTokens
            }

            const modelId = typeof opts.model === 'object' && opts.model
                ? (opts.model as { modelId?: string }).modelId ?? String(opts.model)
                : String(opts.model)

            if (schemaMode) {
                // generateObject path — SDK handles parse + validate +
                // inner retry (maxRetries: 2). Validation failures come
                // up as NoObjectGeneratedError / TypeValidationError
                // which classifyError maps to CALL_MODEL_PARSE.
                genArgs.schema = opts.schema
                if (opts.schemaName !== undefined) genArgs.schemaName = opts.schemaName
                if (opts.schemaDescription !== undefined) genArgs.schemaDescription = opts.schemaDescription

                // generateObject carries a @deprecated jsdoc in ai@6 (the
                // SDK direction is generateText+Output.object) but the
                // entry point itself still works and is the simplest
                // schema path. Cast through a locally-typed wrapper so
                // we can call it without tripping no-deprecated at the
                // call site.
                const generateObjectUntyped = generateObject as unknown as (
                    args: unknown,
                ) => Promise<{ object: unknown; usage?: { inputTokens?: number; outputTokens?: number } }>
                let result: { object: unknown; usage?: { inputTokens?: number; outputTokens?: number } }
                try {
                    result = await generateObjectUntyped(genArgs)
                } catch (genErr) {
                    const rescued = tryRescueFencedJson(genErr, opts.schema)
                    if (!rescued) throw genErr
                    logger.warn({
                        event: 'call_model.fence_rescue',
                        workspaceId: opts.workspaceId,
                        taskType: opts.taskType,
                        model: modelId,
                    }, 'callModel: rescued fenced JSON from generateObject failure')
                    result = { object: rescued.object }
                }

                const latencyMs = Date.now() - startedAt
                const inputTokens = result.usage?.inputTokens ?? 0
                const outputTokens = result.usage?.outputTokens ?? 0

                logger.debug({
                    event: 'call_model.success',
                    mode: 'object',
                    workspaceId: opts.workspaceId,
                    taskType: opts.taskType,
                    model: modelId,
                    inputTokens,
                    outputTokens,
                    latencyMs,
                    attempts,
                }, 'callModel (schema) succeeded')

                _onCallComplete?.({ provider: opts.provider ?? 'unknown', model: modelId, taskType: opts.taskType ?? 'unknown', status: 'success', latencySec: latencyMs / 1000 })

                const objectResult: CallModelObjectResult<unknown> = {
                    object: result.object,
                    text: '',
                    inputTokens,
                    outputTokens,
                    latencyMs,
                    model: modelId,
                    attempts,
                }
                return objectResult
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK's generateText overload set is wide
            const result = await generateText(genArgs as any)

            const latencyMs = Date.now() - startedAt
            const inputTokens = result.usage?.inputTokens ?? 0
            const outputTokens = result.usage?.outputTokens ?? 0

            logger.debug({
                event: 'call_model.success',
                mode: 'text',
                workspaceId: opts.workspaceId,
                taskType: opts.taskType,
                model: modelId,
                inputTokens,
                outputTokens,
                latencyMs,
                attempts,
            }, 'callModel succeeded')

            _onCallComplete?.({ provider: opts.provider ?? 'unknown', model: modelId, taskType: opts.taskType ?? 'unknown', status: 'success', latencySec: latencyMs / 1000 })

            return {
                text: result.text ?? '',
                inputTokens,
                outputTokens,
                latencyMs,
                model: modelId,
                attempts,
            }
        } catch (err) {
            lastErr = err
            // Cost-gate threw — re-raise unchanged so agent-loop catches the typed error.
            if (err instanceof CostCeilingExceededError) throw err

            // Check whether the wall-clock timeout fired (as opposed to the
            // caller's signal). If only the composed signal is aborted and the
            // caller's signal is still alive, the timeout won. Distinguish
            // so the error code matches the real cause.
            const timedOut = composedSignal.aborted
                && (!opts.signal || !opts.signal.aborted)

            // Retry path: only on transient errors, and only once.
            if (attempts < 2 && isRetryable(err) && !timedOut) {
                logger.debug({
                    event: 'call_model.retry',
                    attempts,
                    delayMs: backoffDelayMs(attempts),
                }, 'callModel transient failure — retrying')
                await new Promise(resolve => setTimeout(resolve, backoffDelayMs(attempts)))
                continue
            }

            // Terminal: wrap in CallModelError with a sentinel code.
            const code = classifyError(err, timedOut)
            const message = err instanceof Error ? err.message : String(err ?? 'unknown')
            logger.warn({
                event: 'call_model.failure',
                workspaceId: opts.workspaceId,
                taskType: opts.taskType,
                attempts,
                code,
                message: message.slice(0, 200),
            }, 'callModel terminal failure')

            const failLatencyMs = Date.now() - startedAt
            const failModelId = typeof opts.model === 'object' && opts.model
                ? ((opts.model as { modelId?: string }).modelId ?? 'unknown')
                : String(opts.model ?? 'unknown')
            _onCallComplete?.({ provider: opts.provider ?? 'unknown', model: failModelId, taskType: opts.taskType ?? 'unknown', status: 'error', latencySec: failLatencyMs / 1000 })

            throw new CallModelError(message, code, err)
        }
    }

    // Unreachable, but TypeScript wants a return path.
    throw new CallModelError(
        lastErr instanceof Error ? lastErr.message : 'unknown',
        'CALL_MODEL_UNKNOWN',
        lastErr,
    )
}
