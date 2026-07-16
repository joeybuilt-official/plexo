// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import type { SessionEvent } from './contract'
import { summarizeUsage } from './usage'

type UsageFields = Partial<
    Pick<SessionEvent, 'model' | 'provider' | 'tokensIn' | 'tokensOut' | 'costUsd'>
>

function ev(u: UsageFields): SessionEvent {
    return {
        model: null,
        provider: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        ...u,
    } as SessionEvent
}

describe('summarizeUsage', () => {
    it('(a) sums usage-bearing events, ignores non-usage events for eventCount/byModel', () => {
        const s = summarizeUsage([
            ev({ model: 'A', provider: 'p1', tokensIn: 10, tokensOut: 4, costUsd: 0.5 }),
            ev({ model: 'B', provider: 'p2', tokensIn: 3, tokensOut: 1, costUsd: 0.2 }),
            ev({}),
        ])
        expect(s.tokensIn).toBe(13)
        expect(s.tokensOut).toBe(5)
        expect(s.costUsd).toBeCloseTo(0.7, 10)
        expect(s.eventCount).toBe(2)
        expect(s.byModel).toHaveLength(2)
    })

    it('(b) null-model event with only tokensIn still counts toward totals, not byModel', () => {
        const s = summarizeUsage([ev({ tokensIn: 5, tokensOut: null, costUsd: null, model: null })])
        expect(s.tokensIn).toBe(5)
        expect(s.tokensOut).toBe(0)
        expect(s.costUsd).toBe(0)
        expect(s.eventCount).toBe(1)
        expect(s.byModel).toEqual([])
    })

    it('(c) byModel sorted by costUsd desc', () => {
        const s = summarizeUsage([
            ev({ model: 'cheap', costUsd: 0.1 }),
            ev({ model: 'pricey', costUsd: 0.9 }),
        ])
        expect(s.byModel.map((g) => g.model)).toEqual(['pricey', 'cheap'])
    })

    it('(d) empty list → all zeros, empty byModel', () => {
        const s = summarizeUsage([])
        expect(s).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, eventCount: 0, byModel: [] })
    })
})
