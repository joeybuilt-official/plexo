// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tool-result context projector.
 *
 * The executor builds up a growing `messages` array across steps by
 * concatenating each response's messages into the conversation. Tool results
 * (especially web_read_page, which can return up to 30k chars of readable
 * text) are stored verbatim inside those messages. Without projection, every
 * subsequent step re-ingests the entire body of every prior tool result —
 * tokens grow linearly with step count and a 5-step task can balloon past
 * 30k input tokens for a task whose real payload is <1k.
 *
 * `compactStaleToolResults` walks `messages` in-place and replaces stale
 * tool-result bodies with short abstracts, preserving the most recent `keep`
 * tool-result parts at full fidelity. It only truncates entries whose
 * payload exceeds `maxBytes`; small results (e.g. write_asset's
 * "Asset saved: ..." line) are never touched.
 *
 * It matches AI SDK v6's response message shape:
 *   { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName,
 *                               output: { type: 'text', value: '<bytes>' } }] }
 * and also handles the legacy flat shape (`output` as a string, or a
 * top-level `result` string).
 *
 * This is the fix for the "create HTML snake game" 7-minute-12-step
 * termination bug observed on task 01KNZCXVC9GGC7NFJ0TMETGPG8. See the
 * root-cause notes in fix/executor-simple-task-termination.
 */

const STALE_TOOL_RESULT_MAX_BYTES = 600
const RECENT_TOOL_RESULTS_KEPT_FULL = 1
const STALE_ASSISTANT_MAX_CHARS = 800
const RECENT_ASSISTANT_KEPT_FULL = 5

export function compactStaleToolResults(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK message shape is versioned
    messages: any[],
    opts: { keep?: number; maxBytes?: number } = {},
): void {
    const keep = opts.keep ?? RECENT_TOOL_RESULTS_KEPT_FULL
    const maxBytes = opts.maxBytes ?? STALE_TOOL_RESULT_MAX_BYTES

    if (!Array.isArray(messages)) return

    // Walk from the end, count tool-result payload parts we've seen, leave
    // the newest `keep` untouched. Anything older that exceeds maxBytes gets
    // its output value replaced with a short abstract.
    let seen = 0
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!msg || msg.role !== 'tool') continue
        const content = Array.isArray(msg.content) ? msg.content : null
        if (!content) continue

        for (const part of content) {
            if (!part || part.type !== 'tool-result') continue
            const toolName: string = part.toolName ?? 'tool'

            // Extract the text payload regardless of which shape the SDK used.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const output: any = part.output
            let payload: string | null = null
            let writeBack: 'output-value' | 'output-string' | 'result' | null = null
            if (output && typeof output === 'object') {
                if (typeof output.value === 'string') {
                    payload = output.value
                    writeBack = 'output-value'
                }
            } else if (typeof output === 'string') {
                payload = output
                writeBack = 'output-string'
            } else if (typeof part.result === 'string') {
                payload = part.result
                writeBack = 'result'
            }
            if (payload == null || writeBack == null) continue

            seen++
            if (seen <= keep) continue
            if (payload.length <= maxBytes) continue

            const abstract = `[${toolName} result from prior step: ${payload.length} chars, compacted to save context. Content was used to produce subsequent steps.]`
            switch (writeBack) {
                case 'output-value':
                    part.output = { ...output, value: abstract }
                    break
                case 'output-string':
                    part.output = abstract
                    break
                case 'result':
                    part.result = abstract
                    break
            }
        }
    }
}

/**
 * FUN-016: Compact stale assistant messages.
 *
 * Assistant text messages grow unbounded across executor steps. This function
 * replaces old assistant messages (beyond the most recent `keepRecent`) with
 * short placeholders, preserving token budget. Tool-call messages (assistant
 * messages whose content includes tool_call parts) are left intact so the
 * tool-result pairing stays valid.
 */
export function compactStaleAssistantMessages(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK message shape is versioned
    messages: any[],
    opts: { keepRecent?: number; maxChars?: number } = {},
): void {
    const keepRecent = opts.keepRecent ?? RECENT_ASSISTANT_KEPT_FULL
    const maxChars = opts.maxChars ?? STALE_ASSISTANT_MAX_CHARS

    if (!Array.isArray(messages)) return

    // Collect indices of pure-text assistant messages (no tool_call parts).
    const assistantIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (!msg || msg.role !== 'assistant') continue

        // Skip messages that contain tool calls — those must stay paired with tool results
        if (Array.isArray(msg.content)) {
            const hasToolCall = msg.content.some((p: any) => p?.type === 'tool-call')
            if (hasToolCall) continue
        }

        assistantIndices.push(i)
    }

    // Only compact messages beyond the most recent `keepRecent`
    const compactCount = assistantIndices.length - keepRecent
    if (compactCount <= 0) return

    for (let j = 0; j < compactCount; j++) {
        const idx = assistantIndices[j]!
        const msg = messages[idx]

        // Extract text length for the placeholder
        let textLen = 0
        if (typeof msg.content === 'string') {
            textLen = msg.content.length
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part?.type === 'text' && typeof part.text === 'string') {
                    textLen += part.text.length
                }
            }
        }

        // Only compact if the text is large enough to matter
        if (textLen <= maxChars) continue

        const placeholder = `[Earlier assistant response — ${textLen} chars]`
        if (typeof msg.content === 'string') {
            msg.content = placeholder
        } else if (Array.isArray(msg.content)) {
            // Replace text parts, keep non-text parts (shouldn't exist for pure-text, but defensive)
            msg.content = msg.content.map((part: any) => {
                if (part?.type === 'text' && typeof part.text === 'string') {
                    return { type: 'text', text: placeholder }
                }
                return part
            })
        }
    }
}
