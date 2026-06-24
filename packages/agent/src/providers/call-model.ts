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
    /** True when the schema-mode call fell through to the generateText repair path. */
    repairUsed?: boolean
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
    /**
     * C5 — model-compatibility fall-through chain. When supplied AND a
     * schema-capability error survives the in-wrapper repair retry
     * (`generateText` + JSON-extract + zod-validate), the wrapper falls
     * through to the next entry as a fresh repair attempt. Each model is
     * tried with N=2 (native generateObject → generateText repair) before
     * advancing. Default empty: throw the parse error after repair fails.
     *
     * Note: cross-provider cascade for callers that go through
     * `routeAndCall` (`providers/router-v2/index.ts`) is handled at THAT
     * layer — this option is for direct `callModel({ schema })` callers
     * that want their own per-call chain.
     */
    fallbackChain?: AnyLanguageModel[]
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
    /**
     * True when native `generateObject` failed and the result was produced
     * by the in-wrapper repair path (`generateText` + JSON-extract +
     * zod-validate, or fenced-JSON rescue). Used by the pre-flight
     * model-compat validator to record `compat_native` vs `compat_via_repair`.
     */
    repairUsed: boolean
}

export type CallModelErrorCode =
    | 'CALL_MODEL_ABORTED'
    | 'CALL_MODEL_TIMEOUT'
    | 'CALL_MODEL_RATE_LIMIT'
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
    // Rate-limit BEFORE the generic 4xx bucket: a 429 (or a bare "Too Many
    // Requests" with no parseable status, as managed pools like ollama_cloud
    // surface) must carry the dedicated code so the router/agent-loop treat it
    // as transient + fallback-worthy rather than a terminal CALL_MODEL_UNKNOWN.
    if (isRateLimitError(err)) return 'CALL_MODEL_RATE_LIMIT'
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

const RATE_LIMIT_MSG_RE = /rate.?limit|too many requests|\b429\b/i

function isRateLimitError(err: unknown): boolean {
    if (extractStatus(err) === 429) return true
    const msg = err instanceof Error ? err.message : String(err ?? '')
    return RATE_LIMIT_MSG_RE.test(msg)
}

/** Parse a provider-supplied retry-after hint (seconds or ms) to ms. */
function retryAfterMs(err: unknown): number | undefined {
    const msg = err instanceof Error ? err.message : String(err ?? '')
    const m = msg.match(/retry[- ]after[:\s]*(\d+(?:\.\d+)?)/i)
    if (!m) return undefined
    const v = parseFloat(m[1]!)
    return v < 100 ? v * 1000 : v
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
    // Some managed pools (e.g. ollama_cloud) surface a rate-limit as a bare
    // "Too Many Requests" Error with NO parseable HTTP status, so extractStatus
    // returns null above. Catch it by message so a transient 429 is retried in
    // place instead of falling straight through to terminal failure + a dropped
    // background extraction episode.
    if (isRateLimitError(err)) return true
    // Network-layer errors without a status: retry
    const msg = err instanceof Error ? err.message : String(err ?? '')
    if (/ECONNRESET|ENOTFOUND|ETIMEDOUT|socket|fetch failed/i.test(msg)) return true
    return false
}

function backoffDelayMs(attempt: number, err?: unknown): number {
    // attempt is 1-indexed (1 = first retry). Honor a provider retry-after hint
    // when given. Otherwise rate-limit errors back off longer than generic
    // transients. Full jitter (+0..base) de-synchronizes concurrent retries so
    // they don't re-hammer a shared managed pool in lockstep.
    const hint = retryAfterMs(err)
    if (hint !== undefined) return hint + Math.random() * 250
    const base = isRateLimitError(err)
        ? (attempt === 1 ? 1000 : 2000)
        : (attempt === 1 ? 500 : 1500)
    return base + Math.random() * base
}

// ── schema_relaxed telemetry ──────────────────────────────────────────
// In-process counters for how often a structured-output call was saved by a
// relaxation/coercion path instead of failing. Per the stabilization pre-mortem:
// surfacing "how often the safety net fires" guards against silently masking a
// model that can't actually produce structured output. Per-process, snapshot-
// friendly (same philosophy as router-v2 stats).

interface SchemaRelaxedCounts {
    fenceRescue: number      // raw fenced JSON recovered from a generateObject failure
    repairArrayWrap: number  // repair output was a top-level array, wrapped to fit
    repairRekey: number      // repair output had the wrong wrap key, renamed
    repairValidated: number  // repair generateText output validated after extraction
}

const schemaRelaxedCounts: SchemaRelaxedCounts = {
    fenceRescue: 0, repairArrayWrap: 0, repairRekey: 0, repairValidated: 0,
}

export function recordSchemaRelaxed(kind: keyof SchemaRelaxedCounts): void {
    schemaRelaxedCounts[kind]++
}

export function getSchemaRelaxedStats(): SchemaRelaxedCounts & { total: number } {
    const c = schemaRelaxedCounts
    return { ...c, total: c.fenceRescue + c.repairArrayWrap + c.repairRekey + c.repairValidated }
}

/** Test-only — reset all schema_relaxed counters. */
export function _resetSchemaRelaxedForTest(): void {
    schemaRelaxedCounts.fenceRescue = 0
    schemaRelaxedCounts.repairArrayWrap = 0
    schemaRelaxedCounts.repairRekey = 0
    schemaRelaxedCounts.repairValidated = 0
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
    if (whole?.[1] !== undefined) return whole[1].trim()
    // Second try: first fenced block anywhere in the string (handles preamble/postamble).
    const inner = text.match(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```/)
    if (inner?.[1] !== undefined) return inner[1].trim()
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

function getZodObjectKeys(schema: ZodType<unknown>): string[] {
    const def = (schema as { _def?: { shape?: unknown } })._def
    const shape = def?.shape
    if (typeof shape === 'function') {
        try { return Object.keys((shape as () => Record<string, unknown>)()) } catch { /* fall through */ }
    } else if (shape && typeof shape === 'object') {
        try { return Object.keys(shape as Record<string, unknown>) } catch { /* fall through */ }
    }
    return []
}

const COMMON_WRAP_KEYS = ['nodes', 'edges', 'extracted_entities', 'extracted_nodes', 'extracted_edges', 'entities', 'results', 'items', 'data', 'list', 'facts', 'records']

function tryWrapArrayInObject(
    parsed: unknown,
    schema: ZodType<unknown>,
): { success: true; data: unknown; wrappedWith: string } | { success: false; triedKeys: string[] } {
    if (!Array.isArray(parsed)) return { success: false, triedKeys: [] }
    const introspectKeys = getZodObjectKeys(schema)
    const candidateSet = new Set<string>([...introspectKeys, ...COMMON_WRAP_KEYS])
    const tried: string[] = []
    for (const key of candidateSet) {
        tried.push(key)
        const wrapped = { [key]: parsed }
        const result = schema.safeParse(wrapped)
        if (result.success) return { success: true, data: result.data, wrappedWith: key }
    }
    return { success: false, triedKeys: tried }
}

function tryRekeyObject(
    parsed: unknown,
    schema: ZodType<unknown>,
): { success: true; data: unknown; rekeyedFrom: string; rekeyedTo: string } | { success: false; triedRenames: string[] } {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { success: false, triedRenames: [] }
    }
    const obj = parsed as Record<string, unknown>
    const objKeys = Object.keys(obj)
    if (objKeys.length !== 1) return { success: false, triedRenames: [] }
    const fromKey = objKeys[0]!
    const introspectKeys = getZodObjectKeys(schema)
    const candidateSet = new Set<string>([...introspectKeys, ...COMMON_WRAP_KEYS])
    const tried: string[] = []
    for (const toKey of candidateSet) {
        if (toKey === fromKey) continue
        tried.push(toKey)
        const renamed = { [toKey]: obj[fromKey] }
        const result = schema.safeParse(renamed)
        if (result.success) return { success: true, data: result.data, rekeyedFrom: fromKey, rekeyedTo: toKey }
    }
    return { success: false, triedRenames: tried }
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

// ── Schema-capability detection (C5) ──────────────────────────────────
// Some providers (e.g. most Groq models, ollama_cloud routed through
// @ai-sdk/openai-compatible without `structuredOutputs`) reject json_schema
// mode outright OR return non-JSON when asked for it. The signature is
// either a NoObjectGeneratedError / TypeValidationError / JSONParseError
// (parse failure after the fact) OR a provider error mentioning the
// json_schema / response_format / structured-output capability. Mirrors
// the detection sprint/planner.ts:129-149 used before this wrapper subsumed it.
//
// We treat parse failures as repair-eligible because the model already
// produced text — re-running with an explicit "JSON only" directive often
// recovers transient bad-JSON cases at the same cost as one extra call.
// The trade is a 2× call-count amplification on legitimately broken parses;
// acceptable because the alternative (raise immediately) still pays for
// the failed first attempt without giving the model a chance to recover.
function isSchemaCapabilityError(err: unknown): boolean {
    if (isParseError(err)) return true
    const msg = err instanceof Error
        ? err.message
        : typeof err === 'object' && err && 'message' in err && typeof (err as { message: unknown }).message === 'string'
            ? (err as { message: string }).message
            : String(err ?? '')
    if (!msg) return false
    return /json_schema|response.?format|structured.?output/i.test(msg)
}

// Render a zod schema as a hint for the model in repair mode. We don't
// have full zod-to-JSON-Schema here (the SDK does it natively, but we're
// off the schema-mode path now), so we lean on the description if the
// caller supplied one and otherwise instruct "match the schema strictly".
function buildRepairInstruction(opts: { schemaDescription?: string }): string {
    const schemaHint = opts.schemaDescription
        ? `Schema:\n${opts.schemaDescription}\n\n`
        : ''
    return (
        `\n\nRespond with ONLY a JSON object — no markdown fences, no commentary, ` +
        `no preamble. The response must be valid JSON that matches the requested ` +
        `structure exactly.\n\n${schemaHint}`
    )
}

// ── Stub mode (Phase K) ───────────────────────────────────────────────
// `PLEXO_LLM_STUB=true` short-circuits callModel and returns a
// deterministic canned response. Used by Playwright e2e tests so they
// can drive planner + judge code paths without real inference cost or
// flake.
//
// Coverage:
//   - text mode + taskType==='planning' → returns a deterministic JSON
//     plan whose shape matches `PlannerOutputSchema` in
//     `packages/agent/src/planner/index.ts`. Shape varies by prompt:
//       * trivial prompts (matches /what time|what's the time|hello/i)
//         → 1-step plan, no OWDs, no PlanCard renders.
//       * everything else → 3-step plan with one OWD (state_change,
//         requiresApproval=true) so PlanCard renders + approval flow
//         engages.
//   - schema mode + JudgmentSchema-shaped (has `scores` array of
//     DimensionScoreSchema + `overall_notes`) → canned mid-quality
//     judgment object.
//   - any other text-mode call → returns `{ text: '[STUB]
//     deterministic response' }`. (NB: the executor uses generateText
//     directly, not callModel — this stub does NOT cover that path.
//     Tests that drive task execution past the approval gate still
//     need a separate executor stub.)
//   - any other schema-mode call → throws CallModelError with a clear
//     "stub does not know schema" message so the gap is visible
//     immediately rather than silently producing garbage.
function isPlexoLlmStubEnabled(): boolean {
    return process.env.PLEXO_LLM_STUB === 'true'
}

const STUB_PLAN_TRIVIAL = {
    type: 'plan' as const,
    goal: 'Answer the user trivially',
    steps: [
        {
            stepNumber: 1,
            description: 'Provide a one-line answer',
            toolsRequired: ['task_complete'],
            verificationMethod: 'Manual review',
            isOneWayDoor: false,
            depends_on: [] as number[],
        },
    ],
    oneWayDoors: [] as unknown[],
    estimatedDurationMs: 1000,
    confidenceScore: 0.95,
    risks: [] as string[],
    phases: [] as unknown[],
}

const STUB_PLAN_MULTISTEP = {
    type: 'plan' as const,
    goal: 'Push code, run tests, open a PR',
    steps: [
        {
            stepNumber: 1,
            description: 'Push code to the test branch',
            toolsRequired: ['shell'],
            verificationMethod: 'git push exit code is 0',
            isOneWayDoor: true,
            depends_on: [] as number[],
        },
        {
            stepNumber: 2,
            description: 'Run the full test suite',
            toolsRequired: ['shell'],
            verificationMethod: 'Test runner reports all green',
            isOneWayDoor: false,
            depends_on: [1],
        },
        {
            stepNumber: 3,
            description: 'Open a pull request',
            toolsRequired: ['shell'],
            verificationMethod: 'PR URL returned',
            isOneWayDoor: true,
            depends_on: [2],
        },
    ],
    oneWayDoors: [
        {
            description: 'Push to the test branch — propagates work to a shared remote',
            type: 'state_change',
            reversibility: 'Revertible via force-push or branch reset',
            requiresApproval: true,
        },
    ],
    estimatedDurationMs: 60_000,
    confidenceScore: 0.85,
    risks: ['Tests may fail; push will surface as remote state'],
    phases: [
        { label: 'Pushing branch' },
        { label: 'Running tests' },
        { label: 'Opening pull request' },
    ],
}

const STUB_JUDGMENT = {
    scores: [
        { dimension: 'completeness', score: 0.8, rationale: '[STUB] deterministic completeness' },
        { dimension: 'correctness', score: 0.8, rationale: '[STUB] deterministic correctness' },
    ],
    overall_notes: '[STUB] deterministic judgment',
}

function isJudgmentLikeSchema(schema: ZodType<unknown> | undefined): boolean {
    if (!schema) return false
    return schema.safeParse(STUB_JUDGMENT).success
}

function buildStubResult(opts: CallModelOpts<unknown>): CallModelResult | CallModelObjectResult<unknown> {
    const startedAt = Date.now()
    const modelId = typeof opts.model === 'object' && opts.model
        ? (opts.model as { modelId?: string }).modelId ?? 'stub'
        : String(opts.model ?? 'stub')
    const accounting = {
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startedAt,
        model: modelId,
        attempts: 1,
    }

    if (opts.schema) {
        if (isJudgmentLikeSchema(opts.schema)) {
            const validated = opts.schema.safeParse(STUB_JUDGMENT)
            if (validated.success) {
                return {
                    object: validated.data,
                    text: '',
                    repairUsed: false,
                    ...accounting,
                }
            }
        }
        throw new CallModelError(
            `PLEXO_LLM_STUB: stub does not know how to satisfy this schema. Add a canned object for it in call-model.ts (taskType=${opts.taskType ?? 'unknown'}).`,
            'CALL_MODEL_PARSE',
        )
    }

    if (opts.taskType === 'planning') {
        const promptText = (opts.prompt ?? '') + JSON.stringify(opts.messages ?? '')
        const isTrivial = /what\s*time|what'?s\s*the\s*time|^hello$|^hi$/i.test(promptText)
        const plan = isTrivial ? STUB_PLAN_TRIVIAL : STUB_PLAN_MULTISTEP
        return {
            text: JSON.stringify(plan),
            ...accounting,
        }
    }

    return {
        text: '[STUB] deterministic response',
        ...accounting,
    }
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
    // Phase K — deterministic stub mode for e2e tests. Bypasses every
    // downstream concern (cost gate, retries, abort composition) since
    // the canned response is synchronous and free.
    if (isPlexoLlmStubEnabled()) {
        return buildStubResult(opts)
    }

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
                // C5 — generateObject + repair + fall-through.
                // Attempt 1: native `generateObject` (SDK structured-output mode).
                //   On success → return.
                //   On schema-capability error (NoObjectGeneratedError /
                //     TypeValidationError / JSONParseError, or provider-side
                //     "json_schema not supported" message) → repair via
                //     `generateText` against the same model, then JSON-extract
                //     (subsumes the fence-rescue heuristic) and zod-validate.
                //   On any non-schema error → bubble up to outer catch
                //     (transient retry / abort / timeout / 4xx classification).
                // If repair also fails AND `opts.fallbackChain` is non-empty,
                // shift the next entry in and recurse with attempts=1 against
                // the new model. If the chain is empty, throw the parse error.
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

                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK's generateText overload set is wide
                const generateTextUntyped = generateText as unknown as (args: any) => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }>

                let result: { object: unknown; usage?: { inputTokens?: number; outputTokens?: number } }
                let repairUsed = false
                try {
                    result = await generateObjectUntyped(genArgs)
                } catch (genErr) {
                    // Cheap recovery first: in-place fence rescue from the
                    // raw text on the error object (no extra round-trip).
                    const rescued = tryRescueFencedJson(genErr, opts.schema)
                    if (rescued) {
                        logger.warn({
                            event: 'call_model.fence_rescue',
                            workspaceId: opts.workspaceId,
                            taskType: opts.taskType,
                            model: modelId,
                        }, 'callModel: rescued fenced JSON from generateObject failure')
                        recordSchemaRelaxed('fenceRescue')
                        result = { object: rescued.object }
                        repairUsed = true
                    } else if (isSchemaCapabilityError(genErr)) {
                        // C5 repair retry: generateText + repair against the
                        // same model. This is "attempt 2 of N=2" per the
                        // post-audit panel decision. If THIS also fails, we
                        // fall through to opts.fallbackChain (or throw).
                        logger.warn({
                            event: 'call_model.repair_attempt',
                            workspaceId: opts.workspaceId,
                            taskType: opts.taskType,
                            model: modelId,
                        }, 'callModel: schema-capability error — repairing via generateText')

                        const repairArgs: Record<string, unknown> = {
                            model: opts.model,
                            abortSignal: composedSignal,
                        }
                        if (opts.system !== undefined) repairArgs.system = opts.system
                        const repairInstr = buildRepairInstruction({ schemaDescription: opts.schemaDescription })
                        if (opts.prompt !== undefined) {
                            repairArgs.prompt = opts.prompt + repairInstr
                        } else if (opts.messages !== undefined) {
                            // Append the repair directive as a synthetic trailing
                            // user message so the model gets the JSON-only signal
                            // even when the caller used messages-mode. Without
                            // this the repair attempt would re-run identical
                            // input and reproduce the same failure.
                            repairArgs.messages = [
                                ...opts.messages,
                                { role: 'user', content: repairInstr.trim() },
                            ]
                        } else {
                            repairArgs.prompt = repairInstr.trim()
                        }
                        if (opts.maxTokens !== undefined) {
                            repairArgs.maxTokens = opts.maxTokens
                            repairArgs.maxOutputTokens = opts.maxTokens
                        }

                        let repairResult: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }
                        try {
                            repairResult = await generateTextUntyped(repairArgs)
                        } catch (repairErr) {
                            // Repair-mode call itself errored (auth, network,
                            // 5xx, etc). Treat the same as a terminal repair
                            // failure: try the fallback chain or rethrow the
                            // ORIGINAL error so the caller's classifier sees
                            // the schema-mode failure, not the repair noise.
                            logger.warn({
                                event: 'call_model.repair_failed',
                                workspaceId: opts.workspaceId,
                                taskType: opts.taskType,
                                model: modelId,
                                repairErr: repairErr instanceof Error ? repairErr.message.slice(0, 200) : String(repairErr),
                            }, 'callModel: repair generateText errored')
                            if (opts.fallbackChain && opts.fallbackChain.length > 0) {
                                const [next, ...rest] = opts.fallbackChain
                                logger.info({
                                    event: 'call_model.fallback_chain_advance',
                                    workspaceId: opts.workspaceId,
                                    taskType: opts.taskType,
                                    fromModel: modelId,
                                    reason: 'repair_errored',
                                    remainingChainLength: rest.length,
                                }, 'callModel: advancing to next fallback model after repair-call error')
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recursing through the schema-mode overload; ts can't narrow on opts.schema being defined here
                                return callModel({ ...opts, model: next, fallbackChain: rest } as any) as Promise<CallModelObjectResult<unknown>>
                            }
                            throw new CallModelError(
                                `Schema-mode call failed and same-model repair errored: ${genErr instanceof Error ? genErr.message : String(genErr)}`,
                                'CALL_MODEL_PARSE',
                                genErr,
                            )
                        }

                        // Extract JSON from the repair text (reuse the same
                        // fence-stripping heuristic that powers the rescue).
                        const repairText = (repairResult && typeof repairResult.text === 'string')
                            ? repairResult.text
                            : ''
                        const stripped = stripCodeFence(repairText)
                        let parsed: unknown = null
                        if (stripped) {
                            try { parsed = JSON.parse(stripped) } catch { parsed = null }
                        }
                        let validated = parsed !== null && opts.schema
                            ? opts.schema.safeParse(parsed)
                            : (parsed !== null ? { success: true as const, data: parsed } : { success: false as const })

                        if (!validated.success && Array.isArray(parsed) && opts.schema) {
                            const wrapped = tryWrapArrayInObject(parsed, opts.schema)
                            if (wrapped.success) {
                                logger.info({
                                    event: 'call_model.repair_array_wrap',
                                    workspaceId: opts.workspaceId,
                                    taskType: opts.taskType,
                                    model: modelId,
                                    wrappedWith: wrapped.wrappedWith,
                                }, 'callModel: repair output was top-level array; wrapped to satisfy object schema')
                                recordSchemaRelaxed('repairArrayWrap')
                                validated = { success: true as const, data: wrapped.data }
                            }
                        }
                        if (!validated.success && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && opts.schema) {
                            const rekeyed = tryRekeyObject(parsed, opts.schema)
                            if (rekeyed.success) {
                                logger.info({
                                    event: 'call_model.repair_rekey',
                                    workspaceId: opts.workspaceId,
                                    taskType: opts.taskType,
                                    model: modelId,
                                    rekeyedFrom: rekeyed.rekeyedFrom,
                                    rekeyedTo: rekeyed.rekeyedTo,
                                }, 'callModel: repair output had wrong wrap key; renamed to satisfy schema')
                                recordSchemaRelaxed('repairRekey')
                                validated = { success: true as const, data: rekeyed.data }
                            }
                        }

                        if (!validated.success) {
                            logger.warn({
                                event: 'call_model.repair_validation_failed',
                                workspaceId: opts.workspaceId,
                                taskType: opts.taskType,
                                model: modelId,
                            }, 'callModel: repair output failed JSON-parse or zod-validation')
                            if (opts.fallbackChain && opts.fallbackChain.length > 0) {
                                const [next, ...rest] = opts.fallbackChain
                                logger.info({
                                    event: 'call_model.fallback_chain_advance',
                                    workspaceId: opts.workspaceId,
                                    taskType: opts.taskType,
                                    fromModel: modelId,
                                    reason: 'repair_validation_failed',
                                    remainingChainLength: rest.length,
                                }, 'callModel: advancing to next fallback model after repair output failed validation')
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recursing through the schema-mode overload; ts can't narrow on opts.schema being defined here
                                return callModel({ ...opts, model: next, fallbackChain: rest } as any) as Promise<CallModelObjectResult<unknown>>
                            }
                            throw new CallModelError(
                                `Schema-mode call failed and same-model repair output did not validate against schema: ${genErr instanceof Error ? genErr.message : String(genErr)}`,
                                'CALL_MODEL_PARSE',
                                genErr,
                            )
                        }

                        repairUsed = true
                        recordSchemaRelaxed('repairValidated')
                        result = {
                            object: validated.data,
                            usage: repairResult.usage,
                        }
                    } else {
                        // Non-schema error (transient / abort / 4xx / 5xx) —
                        // bubble up to the outer catch so the existing retry
                        // and classifyError logic decide what to do.
                        throw genErr
                    }
                }

                const latencyMs = Date.now() - startedAt
                const inputTokens = result.usage?.inputTokens ?? 0
                const outputTokens = result.usage?.outputTokens ?? 0

                logger.debug({
                    event: 'call_model.success',
                    mode: 'object',
                    repairUsed,
                    workspaceId: opts.workspaceId,
                    taskType: opts.taskType,
                    model: modelId,
                    inputTokens,
                    outputTokens,
                    latencyMs,
                    attempts,
                }, 'callModel (schema) succeeded')

                _onCallComplete?.({ provider: opts.provider ?? 'unknown', model: modelId, taskType: opts.taskType ?? 'unknown', status: 'success', latencySec: latencyMs / 1000, repairUsed })

                const objectResult: CallModelObjectResult<unknown> = {
                    object: result.object,
                    text: '',
                    inputTokens,
                    outputTokens,
                    latencyMs,
                    model: modelId,
                    attempts,
                    repairUsed,
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
            // Already-typed CallModelError (e.g. C5 schema-repair terminal
            // failure threw it directly with the right code) — pass through
            // unchanged. The outer classifier doesn't get a second crack.
            if (err instanceof CallModelError) throw err

            // Check whether the wall-clock timeout fired (as opposed to the
            // caller's signal). If only the composed signal is aborted and the
            // caller's signal is still alive, the timeout won. Distinguish
            // so the error code matches the real cause.
            const timedOut = composedSignal.aborted
                && (!opts.signal || !opts.signal.aborted)

            // Retry path: only on transient errors, and only once.
            if (attempts < 2 && isRetryable(err) && !timedOut) {
                const delayMs = backoffDelayMs(attempts, err)
                logger.debug({
                    event: 'call_model.retry',
                    attempts,
                    delayMs,
                }, 'callModel transient failure — retrying')
                await new Promise(resolve => setTimeout(resolve, delayMs))
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
