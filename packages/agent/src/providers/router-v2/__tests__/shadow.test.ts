// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 Round-6 Phase 1 — shadow path (flag + provisional pick + compute).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const execute = vi.fn()
vi.mock('@plexo/db', () => ({
    db: { execute: (...a: unknown[]) => execute(...a) },
    sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals }),
}))

import {
    isModelRouterEnabled,
    provisionalPick,
    computeShadowChoice,
} from '../shadow.js'
import type { ModelCandidate } from '../candidate.js'
import type { AvailableProvider } from '../selector.js'
import type { WorkspaceAISettings } from '../../registry.js'

const settings: WorkspaceAISettings = {} as WorkspaceAISettings
const ap = (provider: string, model?: string): AvailableProvider =>
    ({ provider, config: { provider, model } } as unknown as AvailableProvider)

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

afterEach(() => {
    delete process.env.PLEXO_MODEL_ROUTER
    execute.mockReset()
})

describe('isModelRouterEnabled', () => {
    it('is OFF by default', () => {
        delete process.env.PLEXO_MODEL_ROUTER
        expect(isModelRouterEnabled()).toBe(false)
    })
    it('is ON only for exactly "1"', () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        expect(isModelRouterEnabled()).toBe(true)
        process.env.PLEXO_MODEL_ROUTER = 'true'
        expect(isModelRouterEnabled()).toBe(false)
    })
})

describe('provisionalPick', () => {
    it('picks highest prior', () => {
        const p = provisionalPick('planning', [cand('a', 'm1', 3), cand('b', 'm2', 5)])
        expect(p?.modelId).toBe('m2')
    })
    it('breaks prior ties by reliability desc', () => {
        const p = provisionalPick('planning', [cand('a', 'm1', 5, 0.8), cand('b', 'm2', 5, 0.99)])
        expect(p?.modelId).toBe('m2')
    })
    it('breaks reliability ties by lower input cost', () => {
        const p = provisionalPick('planning', [cand('a', 'm1', 5, 1, 10), cand('b', 'm2', 5, 1, 2)])
        expect(p?.modelId).toBe('m2')
    })
    it('returns null on empty', () => {
        expect(provisionalPick('planning', [])).toBeNull()
    })
})

describe('computeShadowChoice', () => {
    it('returns null when flag OFF (no DB call)', async () => {
        delete process.env.PLEXO_MODEL_ROUTER
        const out = await computeShadowChoice({ taskType: 'planning', available: [ap('anthropic', 'claude-sonnet-4-6')], settings })
        expect(out).toBeNull()
        expect(execute).not.toHaveBeenCalled()
    })

    it('computes a would-pick when flag ON', async () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        execute.mockResolvedValueOnce({
            rows: [
                { provider: 'anthropic', model_id: 'claude-sonnet-4-6', context_window: 200000, cost_per_m_in: 3, cost_per_m_out: 15, strengths: ['tools'], reliability_score: 0.97 },
            ],
        })
        const out = await computeShadowChoice({
            taskType: 'planning',
            available: [ap('anthropic', 'claude-sonnet-4-6'), ap('deepseek', 'deepseek-v3')],
            settings,
        })
        expect(out).not.toBeNull()
        // anthropic planning prior (5) > deepseek (3)
        expect(out!.chosen).toBe('anthropic/claude-sonnet-4-6')
        expect(out!.prior).toBe(5)
        expect(out!.shortlist.length).toBeGreaterThanOrEqual(1)
    })

    it('returns null (never throws) when the DB read fails', async () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        execute.mockRejectedValueOnce(new Error('db down'))
        const out = await computeShadowChoice({ taskType: 'planning', available: [ap('anthropic', 'claude-sonnet-4-6')], settings })
        expect(out).toBeNull()
    })
})
