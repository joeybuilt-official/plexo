// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pure token-cost estimation (no IO, no framework).
 *
 * A lightweight heuristic (chars / 4) used to *estimate* input-token pressure
 * before a turn, so callers can trigger overflow compaction before the context
 * window is actually exceeded. It is intentionally framework-free so it can be
 * reused by the agent executor and any session-fabric budget math.
 *
 * If a measured token count is already available (e.g. from a provider usage
 * rollup), pass it via `declared` and it is trusted over the heuristic.
 */

const CHARS_PER_TOKEN = 4

export function estimateTokens(content: string, declared?: number | null): number {
    if (declared != null && declared > 0) return Math.floor(declared)
    if (!content) return 0
    return Math.ceil(content.length / CHARS_PER_TOKEN)
}

/**
 * Estimate the total token cost of a serialized conversation. Walks the same
 * AI-SDK message shapes the context projector understands (string content,
 * array text parts, tool-result outputs) and sums per-part estimates.
 */
export function estimateMessagesTokens(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK message shape is versioned
    messages: any[],
    opts: { tokenCounter?: (text: string) => number } = {},
): number {
    const count = opts.tokenCounter ?? estimateTokens
    if (!Array.isArray(messages)) return 0

    let total = 0
    for (const msg of messages) {
        if (!msg) continue
        const content = msg.content
        if (typeof content === 'string') {
            total += count(content)
            continue
        }
        if (Array.isArray(content)) {
            for (const part of content) {
                if (!part) continue
                if (typeof part.text === 'string') total += count(part.text)
                else if (typeof part.value === 'string') total += count(part.value)
                else if (typeof part.result === 'string') total += count(part.result)
                else if (typeof part.reasoning === 'string') total += count(part.reasoning)
                else if (part.output != null) {
                    // tool-result shape: output is a string, or { value|result: string }
                    const output = part.output
                    if (typeof output === 'string') total += count(output)
                    else if (typeof output.value === 'string') total += count(output.value)
                    else if (typeof output.result === 'string') total += count(output.result)
                }
            }
        }
    }
    return total
}
