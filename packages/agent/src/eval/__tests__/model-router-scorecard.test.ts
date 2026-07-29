// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Round-6 Phase 4 — modelRouterScorecard (shadow divergence + A/B). Welch real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const execute = vi.fn()
vi.mock('@plexo/db', () => ({
    db: { execute: (...a: unknown[]) => execute(...a) },
    sql: (s: TemplateStringsArray, ...v: unknown[]) => ({ s, v }),
}))

import { modelRouterScorecard } from '../routing-scorecard.js'

beforeEach(() => execute.mockReset())

describe('modelRouterScorecard', () => {
    it('computes shadow divergence and leaves A/B empty pre-flip', async () => {
        execute
            .mockResolvedValueOnce([{ task_type: 'extraction', shadow_n: 10, divergent_n: 4 }]) // divergence
            .mockResolvedValueOnce([]) // quality A/B (none yet)
        const out = await modelRouterScorecard({ windowDays: 7 })
        expect(out).toHaveLength(1)
        const ex = out[0]!
        expect(ex.taskType).toBe('extraction')
        expect(ex.shadow).toEqual({ n: 10, divergent: 4, divergenceRate: 0.4 })
        expect(ex.ab.router.n).toBe(0)
        expect(ex.ab.baseline.n).toBe(0)
        expect(ex.ab.pValue).toBeNull()
        expect(ex.ab.sufficient).toBe(false)
    })

    it('computes the post-flip A/B Welch when both arms have data', async () => {
        execute
            .mockResolvedValueOnce([{ task_type: 'extraction', shadow_n: 6, divergent_n: 3 }])
            .mockResolvedValueOnce([
                { task_type: 'extraction', model_routed: false, quality: 0.5 },
                { task_type: 'extraction', model_routed: false, quality: 0.55 },
                { task_type: 'extraction', model_routed: false, quality: 0.52 },
                { task_type: 'extraction', model_routed: true, quality: 0.8 },
                { task_type: 'extraction', model_routed: true, quality: 0.82 },
                { task_type: 'extraction', model_routed: true, quality: 0.79 },
            ])
        const out = await modelRouterScorecard({ windowDays: 7, minSamples: 2 })
        const ex = out[0]!
        expect(ex.ab.baseline.n).toBe(3)
        expect(ex.ab.router.n).toBe(3)
        expect(ex.ab.router.meanQuality).toBeGreaterThan(ex.ab.baseline.meanQuality)
        expect(ex.ab.pValue).not.toBeNull()
        expect(ex.ab.pValue!).toBeLessThan(0.05) // router clearly better
        expect(ex.ab.sufficient).toBe(true)
    })

    it('divergenceRate is 0 when no shadow rows', async () => {
        execute
            .mockResolvedValueOnce([{ task_type: 'planning', shadow_n: 0, divergent_n: 0 }])
            .mockResolvedValueOnce([])
        const out = await modelRouterScorecard()
        expect(out[0]!.shadow.divergenceRate).toBe(0)
    })
})
