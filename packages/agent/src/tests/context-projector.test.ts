// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for compactStaleToolResults — the context projector that
 * prevents unbounded input-token growth across executor steps.
 *
 * Regression target: task 01KNZCXVC9GGC7NFJ0TMETGPG8 ("Create HTML-based
 * snake game") grew from 8k → 38k input tokens over 11 steps because
 * web_read_page returned 28k chars of raw HTML-stripped text that was
 * re-fed into every subsequent generateText call.
 */

import { describe, it, expect } from 'vitest'
import { compactStaleToolResults } from '../executor/context-projector.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SUT takes any[]
type Msg = any

// ── Helpers ────────────────────────────────────────────────────

function toolResultMessage(toolName: string, value: string, toolCallId = 'call_1'): Msg {
    return {
        role: 'tool',
        content: [{
            type: 'tool-result',
            toolCallId,
            toolName,
            output: { type: 'text', value },
        }],
    }
}

function userMessage(text: string): Msg {
    return { role: 'user', content: text }
}

function assistantToolCall(toolName: string, toolCallId = 'call_1'): Msg {
    return {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
    }
}

// ── Tests ──────────────────────────────────────────────────────

describe('compactStaleToolResults', () => {
    it('is a no-op for message arrays with no tool results', () => {
        const messages = [
            userMessage('hello'),
            { role: 'assistant', content: 'hi' },
        ]
        const snapshot = JSON.stringify(messages)
        compactStaleToolResults(messages)
        expect(JSON.stringify(messages)).toBe(snapshot)
    })

    it('leaves tool results smaller than the threshold alone', () => {
        const messages = [
            assistantToolCall('write_asset'),
            toolResultMessage('write_asset', 'Asset saved: /tmp/plexo-assets/t1/foo.md (42 bytes)'),
            assistantToolCall('write_asset', 'call_2'),
            toolResultMessage('write_asset', 'Asset saved: /tmp/plexo-assets/t1/bar.md (99 bytes)', 'call_2'),
        ]
        const before = JSON.stringify(messages)
        compactStaleToolResults(messages)
        expect(JSON.stringify(messages)).toBe(before)
    })

    it('keeps the most recent tool-result full-size and compacts older large ones', () => {
        const longText = 'x'.repeat(10_000)
        const messages = [
            assistantToolCall('web_read_page', 'call_a'),
            toolResultMessage('web_read_page', longText, 'call_a'),
            assistantToolCall('web_read_page', 'call_b'),
            toolResultMessage('web_read_page', longText, 'call_b'),
        ]
        compactStaleToolResults(messages)

        // Most-recent is kept full
        expect(messages[3].content[0].output.value).toBe(longText)
        // Older one is abstracted
        const compacted = messages[1].content[0].output.value as string
        expect(compacted.startsWith('[web_read_page result from prior step:')).toBe(true)
        expect(compacted).toContain('10000 chars')
        expect(compacted.length).toBeLessThan(longText.length)
    })

    it('compacts multiple stale large results while keeping the newest', () => {
        const longText = 'y'.repeat(5_000)
        const messages = [
            toolResultMessage('web_search', longText, 'c1'),
            toolResultMessage('web_read_page', longText, 'c2'),
            toolResultMessage('web_read_page', longText, 'c3'),
        ]
        compactStaleToolResults(messages)
        // Newest (c3) preserved
        expect(messages[2].content[0].output.value).toBe(longText)
        // Older two compacted
        expect(messages[0].content[0].output.value).not.toBe(longText)
        expect(messages[1].content[0].output.value).not.toBe(longText)
        expect(messages[0].content[0].output.value as string).toContain('web_search')
        expect(messages[1].content[0].output.value as string).toContain('web_read_page')
    })

    it('handles the legacy string-output shape', () => {
        const longText = 'z'.repeat(5_000)
        const messages: Msg[] = [
            {
                role: 'tool',
                content: [{
                    type: 'tool-result',
                    toolCallId: 'c1',
                    toolName: 'web_fetch',
                    output: longText,
                }],
            },
            {
                role: 'tool',
                content: [{
                    type: 'tool-result',
                    toolCallId: 'c2',
                    toolName: 'web_fetch',
                    output: longText,
                }],
            },
        ]
        compactStaleToolResults(messages)
        expect(messages[1].content[0].output).toBe(longText)
        expect(messages[0].content[0].output).not.toBe(longText)
    })

    it('respects the custom keep and maxBytes options', () => {
        const longText = 'q'.repeat(2_000)
        const messages = [
            toolResultMessage('web_read_page', longText, 'c1'),
            toolResultMessage('web_read_page', longText, 'c2'),
            toolResultMessage('web_read_page', longText, 'c3'),
        ]
        compactStaleToolResults(messages, { keep: 2, maxBytes: 500 })
        // keep=2 → last two preserved, first compacted
        expect(messages[2].content[0].output.value).toBe(longText)
        expect(messages[1].content[0].output.value).toBe(longText)
        expect(messages[0].content[0].output.value).not.toBe(longText)
    })

    it('gracefully handles malformed message arrays', () => {
        expect(() => compactStaleToolResults([])).not.toThrow()
        expect(() => compactStaleToolResults([null as unknown as object])).not.toThrow()
        expect(() => compactStaleToolResults([{ role: 'tool', content: null }])).not.toThrow()
        expect(() => compactStaleToolResults([{ role: 'tool', content: [{ type: 'other' }] }])).not.toThrow()
    })

    it('shrinks total serialized size on a realistic multi-step scenario', () => {
        // Simulates the failing task: web_search (small) → web_read_page (big) →
        // web_read_page (big) → write_asset (small) → write_asset (small).
        const bigPage = 'p'.repeat(28_000)
        const small = 'Asset saved: /tmp/foo (123 bytes)'
        const messages: Msg[] = [
            userMessage('Create HTML snake game'),
            assistantToolCall('web_search', 'c1'),
            toolResultMessage('web_search', 'Found 5 results...', 'c1'),
            assistantToolCall('web_read_page', 'c2'),
            toolResultMessage('web_read_page', bigPage, 'c2'),
            assistantToolCall('web_read_page', 'c3'),
            toolResultMessage('web_read_page', bigPage, 'c3'),
            assistantToolCall('write_asset', 'c4'),
            toolResultMessage('write_asset', small, 'c4'),
        ]
        const sizeBefore = JSON.stringify(messages).length
        compactStaleToolResults(messages)
        const sizeAfter = JSON.stringify(messages).length
        // With keep=1 the most recent tool-result (write_asset, small) is kept,
        // plus the previous big web_read_page at index 6 should now be compacted.
        // Total must shrink substantially.
        expect(sizeAfter).toBeLessThan(sizeBefore / 2)
        // Asset saved line must still be intact
        expect(messages[8].content[0].output.value).toBe(small)
    })
})
