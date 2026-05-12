// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Per-model output-token ceiling lookup.
 *
 * Background: Some provider SDKs (notably deepseek-chat) default to a
 * conservative 4096 output-token cap. When the executor asks the model to
 * write a single large artifact (e.g. a full HTML/JS file, a long blog post,
 * a React component with inline styles) the model runs out of output budget
 * mid-JSON-string inside the tool call, the AI SDK can't parse the partial
 * tool call, the tool never executes, and the executor loops trying again
 * forever.
 *
 * Fix: for each model we know about, forward an explicit `maxTokens` that
 * matches that model's natural maximum. The model will still stop early via
 * `finish_reason: stop` on short replies, so the only cost is "we allow the
 * model to use its full output budget when it needs to". A safe fallback of
 * 8192 is applied for unknown models — double the deepseek-chat default,
 * well under every modern model's ceiling.
 *
 * Operator override: `EXECUTOR_MAX_OUTPUT_TOKENS` env var wins over all
 * per-model defaults when set.
 *
 * Per-task override: the caller (`ExecutionContext.tokenBudget`) still wins
 * over this helper — explicit budgets from sprint/project settings are
 * respected as before. This helper only supplies a floor when no explicit
 * budget is set.
 */

/** Safe fallback for unknown models — well above deepseek-chat's 4096 default. */
const DEFAULT_OUTPUT_CEILING = 8192

/**
 * Known per-model output caps. Keys are matched as lowercased prefix against
 * `${provider}/${modelId}`. Order matters — more specific prefixes should
 * come before less specific ones.
 */
const MODEL_OUTPUT_CEILINGS: ReadonlyArray<readonly [string, number]> = [
    // Anthropic — sonnet 3.5+ supports 8192 natively; 3.5-new / sonnet-4+
    // support up to 64K with the extendedOutputTokens beta. We stay at 8192
    // to avoid requiring the beta header; still 2x deepseek default.
    ['anthropic/claude-opus-4', 32_000],
    ['anthropic/claude-sonnet-4', 32_000],
    ['anthropic/claude-haiku-4', 8192],
    ['anthropic/claude-3-7', 16_000],
    ['anthropic/claude-3-5-sonnet', 8192],
    ['anthropic/claude-3-5-haiku', 8192],
    ['anthropic/claude-3', 4096],

    // OpenAI — gpt-4o family supports 16K output; gpt-4.1 supports 32K;
    // o1/o3 reasoning models have their own higher caps but we stay
    // conservative to avoid surprise cost.
    ['openai/gpt-4.1', 32_000],
    ['openai/gpt-4o', 16_000],
    ['openai/gpt-4-turbo', 4096],
    ['openai/o1', 32_000],
    ['openai/o3', 32_000],

    // Google — gemini 1.5+ supports 8192+ output.
    ['google/gemini-2', 8192],
    ['google/gemini-1.5', 8192],

    // Groq — llama3/llama3.1/llama3.3 support 8192.
    ['groq/llama', 8192],
    ['groq/mixtral', 8192],

    // DeepSeek — deepseek-chat max is 8192 (API accepts it despite the
    // default being 4096), deepseek-reasoner same.
    ['deepseek/deepseek-chat', 8192],
    ['deepseek/deepseek-reasoner', 8192],

    // OpenRouter — varies wildly, use fallback.
]

/**
 * Look up the preferred output-token ceiling for a given (provider, modelId).
 * Returns the env override if set, else the per-model default, else the
 * fallback.
 */
export function resolveOutputCeiling(provider: string, modelId: string): number {
    // Env override wins absolutely.
    const envOverride = Number(process.env.EXECUTOR_MAX_OUTPUT_TOKENS)
    if (Number.isFinite(envOverride) && envOverride > 0) {
        return Math.floor(envOverride)
    }

    const key = `${provider}/${modelId}`.toLowerCase()
    for (const [prefix, cap] of MODEL_OUTPUT_CEILINGS) {
        if (key.startsWith(prefix)) return cap
    }
    return DEFAULT_OUTPUT_CEILING
}

/**
 * Signature of the last tool call we saw succeed-or-fail in this step loop.
 * Used to detect "model keeps emitting the same truncated call over and
 * over" — a safety rail against infinite truncation loops when the model's
 * output simply can't fit in any available ceiling.
 */
export interface ToolCallSignature {
    toolName: string
    argsHash: string
    failed: boolean
}

/** Very cheap, stable hash over tool-call args for loop detection. */
export function hashToolCallArgs(input: unknown): string {
    try {
        const str = JSON.stringify(input ?? null)
        // djb2-ish — good enough for equality detection, no crypto needed.
        let h = 5381
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h + str.charCodeAt(i)) | 0
        }
        return `${str.length}:${h}`
    } catch {
        return '0:0'
    }
}

/**
 * Detects if a generateText step hit the model's output-length ceiling AND
 * produced unparseable / empty tool-call output. This is the canonical
 * "truncated mid-JSON" signal that causes the executor loop.
 *
 * `result` is intentionally typed as unknown because the AI SDK type is
 * generic over the tool set and we only care about a few fields here.
 */
export function detectTruncatedToolCall(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: any,
): { truncated: boolean; toolName: string | null } {
    if (!result) return { truncated: false, toolName: null }
    // AI SDK v5 surfaces finishReason per-step and at top-level. We check
    // both shapes.
    const topFinish: string | undefined = result.finishReason
    const stepFinishes: string[] = Array.isArray(result.steps)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? result.steps.map((s: any) => s.finishReason).filter(Boolean)
        : []
    const hitLength = topFinish === 'length' || stepFinishes.includes('length')
    if (!hitLength) return { truncated: false, toolName: null }

    // Find any tool call that has no matching tool result OR an empty output
    // — classic truncated-tool-call signature.
    const steps: unknown[] = Array.isArray(result.steps) ? result.steps : []
    for (const step of steps) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s: any = step
        const calls: unknown[] = Array.isArray(s.toolCalls) ? s.toolCalls : []
        const results: unknown[] = Array.isArray(s.toolResults) ? s.toolResults : []
        for (const call of calls) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const c: any = call
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const match = results.find((r: any) => r.toolCallId === c.toolCallId)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const output = match ? (match as any).output : undefined
            if (!match || output === undefined || output === '' || output === null) {
                return { truncated: true, toolName: c.toolName ?? null }
            }
        }
    }
    // finishReason=length but no tool calls at all — model ran out while
    // streaming raw text. Treat as truncated so the nudge fires.
    return { truncated: true, toolName: null }
}
