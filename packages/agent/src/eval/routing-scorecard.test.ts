// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@plexo/db', () => ({
    db: { execute },
    sql: Object.assign(function sqlTag() { return {} }, { raw: () => ({}), join: () => ({}) }),
}))

import { routingScorecard, shadowExtractionScorecard } from './routing-scorecard.js'

describe('routingScorecard', () => {
    beforeEach(() => execute.mockReset())

    it('groups quality_score by routed_model with means + sample counts', async () => {
        execute.mockResolvedValueOnce([
            { model: 'deepseek', quality: 0.6 },
            { model: 'deepseek', quality: 0.7 },
            { model: 'deepseek', quality: 0.8 },
            { model: 'cerebras', quality: 0.9 },
            { model: 'cerebras', quality: 0.85 },
        ])
        const sc = await routingScorecard({ taskType: 'extraction', minSamples: 100 })

        // Arms sorted by mean quality descending.
        expect(sc.arms.map((a) => a.model)).toEqual(['cerebras', 'deepseek'])
        const ds = sc.arms.find((a) => a.model === 'deepseek')!
        expect(ds.n).toBe(3)
        expect(ds.meanQuality).toBeCloseTo(0.7, 5)
        const cb = sc.arms.find((a) => a.model === 'cerebras')!
        expect(cb.n).toBe(2)
        expect(cb.meanQuality).toBeCloseTo(0.875, 5)
    })

    it('emits a Welch comparison oriented so b is the higher-mean arm, with a t-stat + p-value', async () => {
        execute.mockResolvedValueOnce([
            { model: 'deepseek', quality: 0.6 },
            { model: 'deepseek', quality: 0.65 },
            { model: 'deepseek', quality: 0.7 },
            { model: 'cerebras', quality: 0.9 },
            { model: 'cerebras', quality: 0.92 },
            { model: 'cerebras', quality: 0.88 },
        ])
        const sc = await routingScorecard({ taskType: 'extraction', minSamples: 3 })
        expect(sc.comparisons).toHaveLength(1)
        const c = sc.comparisons[0]!
        expect(c.b).toBe('cerebras')          // higher mean = challenger
        expect(c.a).toBe('deepseek')
        expect(c.meanB).toBeGreaterThan(c.meanA)
        expect(c.tStat).toBeGreaterThan(0)     // B > A ⇒ positive t
        expect(c.pValue).toBeGreaterThanOrEqual(0)
        expect(c.pValue).toBeLessThanOrEqual(1)
        expect(c.sufficient).toBe(true)        // both arms n=3 ≥ minSamples 3
    })

    it('coerces string quality_score (pg numeric) and excludes arms with <2 samples from comparisons', async () => {
        execute.mockResolvedValueOnce([
            { model: 'deepseek', quality: '0.5' },
            { model: 'deepseek', quality: '0.7' },
            { model: 'lonely', quality: '0.99' }, // single sample → not comparable
        ])
        const sc = await routingScorecard({ minSamples: 2 })
        expect(sc.arms.find((a) => a.model === 'deepseek')!.meanQuality).toBeCloseTo(0.6, 5)
        // Only deepseek (n=2) is comparable; lonely (n=1) drops out → no pairs.
        expect(sc.comparisons).toHaveLength(0)
    })

    it('maps shadow extraction rows', async () => {
        execute.mockResolvedValueOnce([
            { primary_model: 'deepseek', shadow_model: 'cerebras', n: 5, mean_agreement: 0.82, mean_field_delta: -1.4 },
        ])
        const pairs = await shadowExtractionScorecard()
        expect(pairs).toEqual([{
            primaryModel: 'deepseek',
            shadowModel: 'cerebras',
            n: 5,
            meanAgreement: 0.82,
            meanFieldDelta: -1.4,
        }])
    })
})
