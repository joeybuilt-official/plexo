// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 Round-6 Phase 2 — weighted model scorer + selector. Pure.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { modelQualityScore, selectBestModel } from '../score.js'
import type { ModelCandidate } from '../candidate.js'
import type { ReadStats } from '../stats.js'

const stats = (o: Partial<ReadStats> = {}): ReadStats => ({
    sampleCount: 0,
    successRate: 1,
    latencyP50Ms: 0,
    latencyP95Ms: 0,
    cooldownEndAt: 0,
    recentFailurePenalty: 0,
    ...o,
})

const cand = (provider: string, modelId: string, prior: number, reliability = 1, costPerMIn = 0): ModelCandidate =>
    ({
        provider: provider as never,
        modelId,
        capabilities: new Set() as never,
        contextWindow: 0,
        costPerMIn,
        costPerMOut: 0,
        reliability,
        priorScoreByTask: { planning: prior } as never,
    })

const allHealthy = () => stats()

afterEach(() => {
    delete process.env.PLEXO_ROUTING_OBJECTIVE
})

describe('modelQualityScore', () => {
    it('increases with prior', () => {
        expect(modelQualityScore(5, stats(), 1)).toBeGreaterThan(modelQualityScore(3, stats(), 1))
    })
    it('drops with low success rate', () => {
        expect(modelQualityScore(5, stats({ successRate: 0 }), 1)).toBeLessThan(modelQualityScore(5, stats({ successRate: 1 }), 1))
    })
    it('penalizes high p95 latency', () => {
        expect(modelQualityScore(5, stats({ latencyP95Ms: 10000 }), 1)).toBeLessThan(modelQualityScore(5, stats(), 1))
    })
})

describe('selectBestModel (quality-first default)', () => {
    it('picks the highest-quality candidate', () => {
        const ranked = selectBestModel({
            candidates: [cand('a', 'm1', 3), cand('b', 'm2', 5)],
            taskType: 'planning',
            statsFor: allHealthy,
            now: 1000,
        })
        expect(ranked[0]!.candidate.modelId).toBe('m2')
    })

    it('breaks quality ties by lower known cost', () => {
        const ranked = selectBestModel({
            candidates: [cand('a', 'm1', 5, 1, 10), cand('b', 'm2', 5, 1, 2)],
            taskType: 'planning',
            statsFor: allHealthy,
            now: 1000,
        })
        expect(ranked[0]!.candidate.modelId).toBe('m2')
    })

    it('treats unknown cost (0) as most expensive in a tiebreak', () => {
        const ranked = selectBestModel({
            candidates: [cand('a', 'm_unknown', 5, 1, 0), cand('b', 'm_known', 5, 1, 5)],
            taskType: 'planning',
            statsFor: allHealthy,
            now: 1000,
        })
        expect(ranked[0]!.candidate.modelId).toBe('m_known')
    })

    it('prefers non-cooling candidates, even over a higher-prior cooling one', () => {
        const ranked = selectBestModel({
            candidates: [cand('a', 'hot', 5), cand('b', 'cool', 3)],
            taskType: 'planning',
            statsFor: (_p, m) => (m === 'hot' ? stats({ cooldownEndAt: 5000 }) : stats()),
            now: 1000,
        })
        expect(ranked[0]!.candidate.modelId).toBe('cool')
    })

    it('falls back to the cooling pool when ALL are cooling (single-provider rule)', () => {
        const ranked = selectBestModel({
            candidates: [cand('a', 'm1', 5)],
            taskType: 'planning',
            statsFor: () => stats({ cooldownEndAt: 5000 }),
            now: 1000,
        })
        expect(ranked).toHaveLength(1)
        expect(ranked[0]!.candidate.modelId).toBe('m1')
    })

    it('returns [] for no candidates', () => {
        expect(selectBestModel({ candidates: [], taskType: 'planning', statsFor: allHealthy, now: 0 })).toEqual([])
    })
})

describe('selectBestModel (cost-first via env)', () => {
    it('picks the cheapest known-cost candidate', () => {
        process.env.PLEXO_ROUTING_OBJECTIVE = 'cost-first'
        const ranked = selectBestModel({
            candidates: [cand('a', 'pricey', 5, 1, 20), cand('b', 'cheap', 3, 1, 1)],
            taskType: 'planning',
            statsFor: allHealthy,
            now: 1000,
        })
        expect(ranked[0]!.candidate.modelId).toBe('cheap')
    })
})
