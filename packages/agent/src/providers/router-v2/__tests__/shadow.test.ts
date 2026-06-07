// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 Round-6 Phase 1 — shadow path (flag + provisional pick + compute).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const where = vi.fn()
vi.mock('@plexo/db', () => ({
    db: { select: () => ({ from: () => ({ where: (...a: unknown[]) => where(...a) }) }) },
    inArray: (..._a: unknown[]) => ({}),
    modelsKnowledge: {
        provider: 'provider', modelId: 'modelId', contextWindow: 'contextWindow',
        costPerMIn: 'costPerMIn', costPerMOut: 'costPerMOut', strengths: 'strengths',
        reliabilityScore: 'reliabilityScore',
    },
}))

import {
    isModelRouterEnabled,
    isShadowLoggingEnabled,
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
    delete process.env.PLEXO_MODEL_ROUTER_SHADOW
    where.mockReset()
})

describe('flags', () => {
    it('serving flip is OFF by default, ON only for exactly "1"', () => {
        delete process.env.PLEXO_MODEL_ROUTER
        expect(isModelRouterEnabled()).toBe(false)
        process.env.PLEXO_MODEL_ROUTER = '1'
        expect(isModelRouterEnabled()).toBe(true)
        process.env.PLEXO_MODEL_ROUTER = 'true'
        expect(isModelRouterEnabled()).toBe(false)
    })
    it('shadow logging is OFF by default', () => {
        expect(isShadowLoggingEnabled()).toBe(false)
    })
    it('shadow logging ON via its own flag without enabling serving', () => {
        process.env.PLEXO_MODEL_ROUTER_SHADOW = '1'
        expect(isShadowLoggingEnabled()).toBe(true)
        expect(isModelRouterEnabled()).toBe(false)
    })
    it('serving flip implies shadow logging', () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        expect(isShadowLoggingEnabled()).toBe(true)
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
        expect(where).not.toHaveBeenCalled()
    })

    it('computes a would-pick when flag ON', async () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        where.mockResolvedValueOnce([
            { provider: 'anthropic', modelId: 'claude-sonnet-4-6', contextWindow: 200000, costPerMIn: 3, costPerMOut: 15, strengths: ['tools'], reliabilityScore: 0.97 },
        ])
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
        where.mockRejectedValueOnce(new Error('db down'))
        const out = await computeShadowChoice({ taskType: 'planning', available: [ap('anthropic', 'claude-sonnet-4-6')], settings })
        expect(out).toBeNull()
    })
})
