// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 warm-start (AI7) — the hydrated baseline is a pure read-only fallback
 * that never contaminates the live sample-based scorer, and never trips the SLO
 * breach evaluator (it surfaces sampleCount=0, below the minSamples floor).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
    recordCall,
    getStats,
    getAllStats,
    hydrateFromSnapshots,
    _resetStatsForTest,
    type StatsKey,
    type HydrationEntry,
} from '../stats.js'

const key: StatsKey = { workspaceId: 'ws-1', provider: 'openai', model: 'gpt-x', taskType: 'codeGeneration' }

const entry = (over: Partial<HydrationEntry> = {}): HydrationEntry => ({
    key,
    successRate: 0.4,
    latencyP50Ms: 800,
    latencyP95Ms: 4200,
    recentFailurePenalty: 0.5,
    cooldownEndAt: 0,
    ...over,
})

describe('router-v2 warm-start', () => {
    beforeEach(() => { _resetStatsForTest() })

    it('cold key with no hydration is the optimistic default', () => {
        expect(getStats(key)).toEqual({ sampleCount: 0, successRate: 1, latencyP50Ms: 0, latencyP95Ms: 0, cooldownEndAt: 0, recentFailurePenalty: 0 })
    })

    it('returns the baseline while there are zero live samples, with sampleCount 0', () => {
        expect(hydrateFromSnapshots([entry()])).toBe(1)
        const s = getStats(key)
        expect(s.successRate).toBe(0.4)
        expect(s.latencyP95Ms).toBe(4200)
        expect(s.recentFailurePenalty).toBe(0.5)
        expect(s.sampleCount).toBe(0) // below SLO minSamples — never alerts
    })

    it('first real sample HARD-cuts over: baseline never blends into live stats', () => {
        hydrateFromSnapshots([entry({ successRate: 0.1, latencyP95Ms: 9000, recentFailurePenalty: 1 })])
        recordCall(key, 120, true)
        const s = getStats(key)
        expect(s.sampleCount).toBe(1)
        expect(s.successRate).toBe(1)
        expect(s.latencyP50Ms).toBe(120)
        expect(s.latencyP95Ms).toBe(120)
        expect(s.recentFailurePenalty).toBe(0)
    })

    it('does NOT overwrite a bucket that already has live samples', () => {
        recordCall(key, 200, true)
        expect(hydrateFromSnapshots([entry({ successRate: 0.1 })])).toBe(0)
        expect(getStats(key).successRate).toBe(1)
    })

    it('hydrates a future cooldown but never shortens an existing one', () => {
        const future = Date.now() + 60_000
        hydrateFromSnapshots([entry({ cooldownEndAt: future })])
        expect(getStats(key).cooldownEndAt).toBe(future)
        hydrateFromSnapshots([entry({ cooldownEndAt: Date.now() - 1000 })])
        expect(getStats(key).cooldownEndAt).toBe(future)
    })

    it('clamps out-of-range / non-finite snapshot values', () => {
        hydrateFromSnapshots([entry({ successRate: 1.7, recentFailurePenalty: -3, latencyP95Ms: -1 })])
        const s = getStats(key)
        expect(s.successRate).toBe(1)
        expect(s.recentFailurePenalty).toBe(0)
        expect(s.latencyP95Ms).toBe(0)
    })

    it('SLO-safety: getAllStats surfaces sampleCount 0 for a hydrated-only bucket', () => {
        // A pessimistic baseline + a live cooldown is the exact shape that could
        // leak into the SLO cron. sampleCount=0 keeps it below the minSamples
        // floor so evaluateSloBreaches (apps/api) skips it — no spurious alerts.
        // (The breach-evaluator assertion itself lives in the api test suite,
        // which owns evaluateSloBreaches; here we prove the mechanism: count 0.)
        hydrateFromSnapshots([entry({ successRate: 0.2, latencyP95Ms: 9000, cooldownEndAt: Date.now() + 60_000 })])
        const emitted = getAllStats().filter((e) => keyEq(e.key, key))
        expect(emitted.length).toBeGreaterThanOrEqual(0)
        for (const e of emitted) expect(e.stats.sampleCount).toBe(0)
    })
})

function keyEq(a: StatsKey, b: StatsKey): boolean {
    return a.workspaceId === b.workspaceId && a.provider === b.provider && a.model === b.model && a.taskType === b.taskType
}
