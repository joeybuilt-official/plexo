// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { estimateTokens, estimateMessagesTokens } from '@plexo/session-fabric'

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

/**
 * Overflow-triggered compaction (B3 — closes the unbounded-growth failure class).
 *
 * `isOverflow` estimates the conversation's token pressure (reusing the shared
 * `estimateTokens` heuristic from `@plexo/session-fabric`) and returns true once
 * it crosses `contextWindow − buffer`. The buffer leaves headroom for the next
 * model turn so we compact *before* the window is actually exceeded.
 *
 * `pruneOverflowToolOutputs` is the cheap, no-LLM first stage (P3/P4): any tool
 * result exceeding `maxChars` (default 40k) is truncated to its most recent
 * `keepChars` (default 15k) tail. This recovers the bulk of runaway growth from
 * large payloads (web reads, file dumps) without spending a summarization call.
 *
 * `compactOverflow` orchestrates both stages: prune first; if still over budget,
 * delegate to an injected `summarize` port (the LLM 5-heading summary) and
 * replace the conversation with that summary plus the replayed last user turn,
 * so the model resumes from the latest ask. The summarizer is injected rather
 * than called directly to keep this module framework-free and unit-testable.
 */

const OVERFLOW_PRUNE_MAX_CHARS = 40_000
const OVERFLOW_PRUNE_KEEP_CHARS = 15_000
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
const DEFAULT_OVERFLOW_BUFFER_TOKENS = 8_000

export interface OverflowOpts {
    contextWindowTokens?: number
    bufferTokens?: number
    tokenCounter?: (text: string) => number
}

export function isOverflow(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK message shape is versioned
    messages: any[],
    opts: OverflowOpts = {},
): boolean {
    const window = opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
    const buffer = opts.bufferTokens ?? DEFAULT_OVERFLOW_BUFFER_TOKENS
    if (!Array.isArray(messages)) return false
    const used = estimateMessagesTokens(messages, { tokenCounter: opts.tokenCounter })
    return used > window - buffer
}

export function pruneOverflowToolOutputs(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK message shape is versioned
    messages: any[],
    opts: { maxChars?: number; keepChars?: number } = {},
): void {
    const maxChars = opts.maxChars ?? OVERFLOW_PRUNE_MAX_CHARS
    const keepChars = opts.keepChars ?? OVERFLOW_PRUNE_KEEP_CHARS
    if (!Array.isArray(messages)) return

    for (const msg of messages) {
        if (!msg || msg.role !== 'tool') continue
        const content = Array.isArray(msg.content) ? msg.content : null
        if (!content) continue

        for (const part of content) {
            if (!part || part.type !== 'tool-result') continue
            const toolName: string = part.toolName ?? 'tool'

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
            if (payload.length <= maxChars) continue

            // Keep the most recent `keepChars` tail so the model still has the
            // relevant part of a large payload without the full body.
            const tail = payload.slice(payload.length - keepChars)
            const abstract = `[${toolName} result pruned for overflow: kept last ${tail.length}/${payload.length} chars.]\n${tail}`
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

/** Port: turns a conversation transcript into a structured summary string. */
export type SummarizePort = (conversationText: string) => Promise<string>

export interface CompactOverflowOpts extends OverflowOpts {
    maxChars?: number
    keepChars?: number
    summarize?: SummarizePort
    summaryRole?: 'assistant' | 'system'
}

export interface CompactOverflowResult {
    overflow: boolean
    compacted: boolean
    summary?: string
}

export async function compactOverflow(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK message shape is versioned
    messages: any[],
    opts: CompactOverflowOpts = {},
): Promise<CompactOverflowResult> {
    if (!Array.isArray(messages)) return { overflow: false, compacted: false }
    if (!isOverflow(messages, opts)) return { overflow: false, compacted: false }

    // Stage 1 — cheap prune (no LLM). Recovers most runaway growth on its own.
    pruneOverflowToolOutputs(messages, { maxChars: opts.maxChars, keepChars: opts.keepChars })
    if (!isOverflow(messages, opts)) {
        return { overflow: true, compacted: true }
    }

    // Stage 2 — structured summary + replay last user turn.
    const summarize = opts.summarize
    if (!summarize) {
        // No summarizer wired — pruning is the best we can do without the LLM.
        return { overflow: true, compacted: true }
    }

    const conversationText = extractConversationText(messages)
    const summary = await summarize(conversationText)

    let lastUser: unknown = null
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m && m.role === 'user') {
            lastUser = m
            break
        }
    }

    messages.length = 0
    messages.push({ role: opts.summaryRole ?? 'assistant', content: summary })
    if (lastUser != null) messages.push(lastUser)

    return { overflow: true, compacted: true, summary }
}

function extractConversationText(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK message shape is versioned
    messages: any[],
): string {
    const parts: string[] = []
    for (const msg of messages) {
        if (!msg) continue
        const content = msg.content
        let text = ''
        if (typeof content === 'string') {
            text = content
        } else if (Array.isArray(content)) {
            text = content
                .map((p: any) => {
                    if (!p) return ''
                    if (typeof p.text === 'string') return p.text
                    if (typeof p.value === 'string') return p.value
                    if (typeof p.result === 'string') return p.result
                    if (typeof p.reasoning === 'string') return p.reasoning
                    return ''
                })
                .filter(Boolean)
                .join('\n')
        }
        if (text.trim()) parts.push(`[${msg.role}]\n${text}`)
    }
    return parts.join('\n\n')
}
