// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessagesTokens } from './token-cost.js'

describe('estimateTokens', () => {
    it('returns 0 for empty/nullish content', () => {
        expect(estimateTokens('')).toBe(0)
        expect(estimateTokens('')).toBe(0)
    })

    it('uses chars/4 heuristic', () => {
        expect(estimateTokens('x'.repeat(40))).toBe(10)
        expect(estimateTokens('x'.repeat(41))).toBe(11) // ceil
    })

    it('trusts a declared measured count over the heuristic', () => {
        expect(estimateTokens('x'.repeat(1000), 7)).toBe(7)
    })

    it('ignores a non-positive declared count', () => {
        expect(estimateTokens('x'.repeat(40), 0)).toBe(10)
    })
})

describe('estimateMessagesTokens', () => {
    it('handles null/non-array', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(estimateMessagesTokens(null as any)).toBe(0)
    })

    it('sums string, array text, and tool-result outputs', () => {
        const msgs = [
            { role: 'user', content: 'a'.repeat(40) }, // 10
            { role: 'assistant', content: 'b'.repeat(80) }, // 20
            {
                role: 'tool',
                content: [
                    { type: 'tool-result', output: { type: 'text', value: 'c'.repeat(40) } }, // 10
                ],
            },
        ]
        expect(estimateMessagesTokens(msgs)).toBe(40)
    })

    it('honors a custom tokenCounter', () => {
        const msgs = [{ role: 'user', content: 'anything' }]
        expect(estimateMessagesTokens(msgs, { tokenCounter: () => 5 })).toBe(5)
    })
})
