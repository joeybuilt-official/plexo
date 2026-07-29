// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for the tool-result context projector (context-projector.ts).
 *
 * These tests are entirely in-memory — no mocks, no DB, no network.
 * The projector was written to fix the 7-minute 12-step termination bug
 * (task 01KNZCXVC9GGC7NFJ0TMETGPG8) where stale web_read_page payloads
 * ballooned input tokens across executor steps.
 */

import { describe, it, expect } from 'vitest'
import {
    compactStaleToolResults,
    compactStaleAssistantMessages,
} from './context-projector.js'

// Payloads: BIG exceeds the 600-byte default threshold; SMALL does not.
const BIG = 'x'.repeat(700)
const SMALL = 'x'.repeat(100)

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSdkV6ToolMsg(toolName: string, payload: string) {
    return {
        role: 'tool' as const,
        content: [
            {
                type: 'tool-result',
                toolCallId: `call_${Math.random().toString(36).slice(2)}`,
                toolName,
                output: { type: 'text', value: payload },
            },
        ],
    }
}

function makeLegacyStringToolMsg(toolName: string, payload: string) {
    return {
        role: 'tool' as const,
        content: [
            {
                type: 'tool-result',
                toolCallId: `call_${Math.random().toString(36).slice(2)}`,
                toolName,
                output: payload,
            },
        ],
    }
}

function makeLegacyResultFieldMsg(toolName: string, payload: string) {
    return {
        role: 'tool' as const,
        content: [
            {
                type: 'tool-result',
                toolCallId: `call_${Math.random().toString(36).slice(2)}`,
                toolName,
                result: payload,
            },
        ],
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sdkV6Value(msg: any): string {
    return msg.content[0].output.value
}

// ── compactStaleToolResults ───────────────────────────────────────────────────

describe('compactStaleToolResults', () => {
    describe('no-op cases', () => {
        it('handles null input without throwing', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect(() => compactStaleToolResults(null as any)).not.toThrow()
        })

        it('handles non-array input without throwing', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect(() => compactStaleToolResults('str' as any)).not.toThrow()
        })

        it('does not touch non-tool messages', () => {
            const msgs = [
                { role: 'user', content: BIG },
                { role: 'assistant', content: BIG },
            ]
            compactStaleToolResults(msgs)
            expect(msgs[0]!.content).toBe(BIG)
            expect(msgs[1]!.content).toBe(BIG)
        })

        it('leaves small tool-result payloads untouched regardless of position', () => {
            const msgs = [
                makeSdkV6ToolMsg('write_asset', SMALL),
                makeSdkV6ToolMsg('write_asset', SMALL),
                makeSdkV6ToolMsg('write_asset', SMALL),
            ]
            compactStaleToolResults(msgs)
            expect(sdkV6Value(msgs[0])).toBe(SMALL)
            expect(sdkV6Value(msgs[1])).toBe(SMALL)
            expect(sdkV6Value(msgs[2])).toBe(SMALL)
        })

        it('compacts nothing when keep >= number of tool results', () => {
            const msgs = [
                makeSdkV6ToolMsg('web_read_page', BIG),
                makeSdkV6ToolMsg('web_read_page', BIG),
            ]
            compactStaleToolResults(msgs, { keep: 5 })
            expect(sdkV6Value(msgs[0])).toBe(BIG)
            expect(sdkV6Value(msgs[1])).toBe(BIG)
        })
    })

    describe('SDK v6 shape — output.value', () => {
        it('compacts the stale entry; keeps the most recent at full fidelity (default keep=1)', () => {
            const msgs = [
                makeSdkV6ToolMsg('web_read_page', BIG), // stale
                makeSdkV6ToolMsg('web_read_page', BIG), // most recent — keep
            ]
            compactStaleToolResults(msgs)

            // Most recent (index 1) untouched
            expect(sdkV6Value(msgs[1])).toBe(BIG)
            // Stale (index 0) compacted
            const compacted = sdkV6Value(msgs[0])
            expect(compacted).not.toBe(BIG)
            expect(compacted).toContain('web_read_page result from prior step')
            expect(compacted).toContain('compacted to save context')
        })

        it('embeds the original payload length in the abstract', () => {
            const msgs = [
                makeSdkV6ToolMsg('web_read_page', BIG),
                makeSdkV6ToolMsg('web_read_page', BIG),
            ]
            compactStaleToolResults(msgs)
            expect(sdkV6Value(msgs[0])).toContain(`${BIG.length} chars`)
        })

        it('preserves the outer output object shape (only replaces value)', () => {
            const msgs = [makeSdkV6ToolMsg('web_read_page', BIG), makeSdkV6ToolMsg('web_read_page', BIG)]
            compactStaleToolResults(msgs)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const output = (msgs[0]!.content[0] as any).output
            expect(output).toHaveProperty('type', 'text')
            expect(typeof output.value).toBe('string')
        })

        it('keeps `keep=2` most recent entries at full fidelity', () => {
            const msgs = [
                makeSdkV6ToolMsg('tool_a', BIG), // stale
                makeSdkV6ToolMsg('tool_b', BIG), // keep
                makeSdkV6ToolMsg('tool_c', BIG), // keep
            ]
            compactStaleToolResults(msgs, { keep: 2 })
            expect(sdkV6Value(msgs[0])).not.toBe(BIG)
            expect(sdkV6Value(msgs[1])).toBe(BIG)
            expect(sdkV6Value(msgs[2])).toBe(BIG)
        })

        it('handles keep=0 — compacts all large tool results', () => {
            const msgs = [
                makeSdkV6ToolMsg('tool_a', BIG),
                makeSdkV6ToolMsg('tool_b', BIG),
            ]
            compactStaleToolResults(msgs, { keep: 0 })
            expect(sdkV6Value(msgs[0])).not.toBe(BIG)
            expect(sdkV6Value(msgs[1])).not.toBe(BIG)
        })

        it('respects a custom maxBytes threshold', () => {
            const medium = 'y'.repeat(200) // below default 600, above custom 100
            const msgs = [
                makeSdkV6ToolMsg('tool_a', medium),
                makeSdkV6ToolMsg('tool_b', medium),
            ]
            // With default maxBytes=600 — no compaction (200 < 600)
            compactStaleToolResults(msgs)
            expect(sdkV6Value(msgs[0])).toBe(medium)

            // With maxBytes=100 — stale compacted
            const msgs2 = [
                makeSdkV6ToolMsg('tool_a', medium),
                makeSdkV6ToolMsg('tool_b', medium),
            ]
            compactStaleToolResults(msgs2, { maxBytes: 100 })
            expect(sdkV6Value(msgs2[0])).not.toBe(medium)
            expect(sdkV6Value(msgs2[1])).toBe(medium) // most recent kept
        })
    })

    describe('legacy flat output-string shape', () => {
        it('compacts stale large output-as-string results', () => {
            const msgs = [
                makeLegacyStringToolMsg('web_read_page', BIG), // stale
                makeLegacyStringToolMsg('web_read_page', BIG), // recent
            ]
            compactStaleToolResults(msgs)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((msgs[0]!.content[0] as any).output).not.toBe(BIG)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((msgs[0]!.content[0] as any).output).toContain('compacted to save context')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((msgs[1]!.content[0] as any).output).toBe(BIG)
        })
    })

    describe('legacy result-field shape', () => {
        it('compacts stale large result-field results', () => {
            const msgs = [
                makeLegacyResultFieldMsg('web_read_page', BIG), // stale
                makeLegacyResultFieldMsg('web_read_page', BIG), // recent
            ]
            compactStaleToolResults(msgs)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((msgs[0]!.content[0] as any).result).not.toBe(BIG)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((msgs[0]!.content[0] as any).result).toContain('compacted to save context')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((msgs[1]!.content[0] as any).result).toBe(BIG)
        })
    })

    describe('mixed message types', () => {
        it('ignores user/assistant messages sandwiched between tool messages', () => {
            const msgs = [
                makeSdkV6ToolMsg('tool_a', BIG),   // stale
                { role: 'user', content: 'ok' },
                { role: 'assistant', content: 'step done' },
                makeSdkV6ToolMsg('tool_b', BIG),   // recent — keep
            ]
            compactStaleToolResults(msgs)
            expect(sdkV6Value(msgs[0])).not.toBe(BIG)
            expect(sdkV6Value(msgs[3])).toBe(BIG)
            // User/assistant untouched
            expect((msgs[1] as { content: string }).content).toBe('ok')
        })
    })
})

// ── compactStaleAssistantMessages ─────────────────────────────────────────────

describe('compactStaleAssistantMessages', () => {
    const LONG = 'z'.repeat(900) // exceeds default maxChars=800
    const SHORT = 'z'.repeat(100)

    describe('no-op cases', () => {
        it('handles null input without throwing', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect(() => compactStaleAssistantMessages(null as any)).not.toThrow()
        })

        it('does not touch short assistant messages', () => {
            const msgs = [
                { role: 'assistant', content: SHORT },
                { role: 'assistant', content: SHORT },
            ]
            compactStaleAssistantMessages(msgs)
            expect(msgs[0]!.content).toBe(SHORT)
            expect(msgs[1]!.content).toBe(SHORT)
        })

        it('does not compact when there are fewer pure-text messages than keepRecent', () => {
            const msgs = [{ role: 'assistant', content: LONG }]
            compactStaleAssistantMessages(msgs)
            expect(msgs[0]!.content).toBe(LONG)
        })

        it('never compacts assistant messages that contain tool-call parts', () => {
            const toolCallMsg = {
                role: 'assistant',
                content: [
                    { type: 'tool-call', toolName: 'write_file', toolCallId: 'tc1', input: {} },
                ],
            }
            const msgs = [
                toolCallMsg,
                { role: 'assistant', content: LONG },
                { role: 'assistant', content: LONG },
                { role: 'assistant', content: LONG },
                { role: 'assistant', content: LONG },
                { role: 'assistant', content: LONG },
            ]
            compactStaleAssistantMessages(msgs)
            // Tool-call message never touched
            expect(msgs[0]!.content).toBe(toolCallMsg.content)
            // All remaining pure-text messages kept (5 ≤ keepRecent=5 default)
            expect(msgs[1]!.content).toBe(LONG)
        })
    })

    describe('string content compaction', () => {
        it('compacts old messages; keeps the 5 most recent intact (default keepRecent=5)', () => {
            const msgs = Array.from({ length: 7 }, () => ({ role: 'assistant', content: LONG }))
            compactStaleAssistantMessages(msgs)

            // 7 messages, keep=5 → 2 oldest compacted
            expect(msgs[0]!.content).toContain('Earlier assistant response')
            expect(msgs[1]!.content).toContain('Earlier assistant response')
            // 5 most recent kept
            for (let i = 2; i < 7; i++) {
                expect(msgs[i]!.content).toBe(LONG)
            }
        })

        it('embeds original char count in the placeholder', () => {
            const msgs = Array.from({ length: 6 }, () => ({ role: 'assistant', content: LONG }))
            compactStaleAssistantMessages(msgs)
            expect(msgs[0]!.content).toContain(`${LONG.length} chars`)
        })
    })

    describe('array content compaction', () => {
        it('compacts old array-content (text parts) assistant messages', () => {
            const makeArrayMsg = (text: string) => ({
                role: 'assistant' as const,
                content: [{ type: 'text', text }],
            })
            const msgs = Array.from({ length: 6 }, () => makeArrayMsg(LONG))
            compactStaleAssistantMessages(msgs)

            // First (stale) compacted
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stalePart = (msgs[0]!.content as any)[0]
            expect(stalePart.type).toBe('text')
            expect(stalePart.text).toContain('Earlier assistant response')
            // Most recent kept
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((msgs[5]!.content as any)[0].text).toBe(LONG)
        })
    })

    describe('custom opts', () => {
        it('respects keepRecent=1 — compacts all but the last', () => {
            const msgs = [
                { role: 'assistant', content: LONG },
                { role: 'assistant', content: LONG },
                { role: 'assistant', content: LONG },
            ]
            compactStaleAssistantMessages(msgs, { keepRecent: 1 })
            expect(msgs[0]!.content).toContain('Earlier assistant response')
            expect(msgs[1]!.content).toContain('Earlier assistant response')
            expect(msgs[2]!.content).toBe(LONG)
        })

        it('respects custom maxChars — does not compact messages under the threshold', () => {
            const medium = 'a'.repeat(300) // below default 800, above custom 200
            const msgs = Array.from({ length: 6 }, () => ({ role: 'assistant', content: medium }))

            // Default maxChars=800: medium(300) never compacted
            compactStaleAssistantMessages(msgs)
            expect(msgs[0]!.content).toBe(medium)

            // Custom maxChars=200: stale medium compacted
            const msgs2 = Array.from({ length: 6 }, () => ({ role: 'assistant', content: medium }))
            compactStaleAssistantMessages(msgs2, { maxChars: 200 })
            expect(msgs2[0]!.content).toContain('Earlier assistant response')
            expect(msgs2[5]!.content).toBe(medium)
        })
    })
})
