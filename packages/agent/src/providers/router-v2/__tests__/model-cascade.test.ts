// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 Round-6 Phase 3 — model-granular cascade (flag ON).
 * A failing top model cascades to the next ranked model; flag OFF unaffected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let selectRows: unknown[] = []
vi.mock('@plexo/db', () => ({
    db: {
        select: () => ({ from: () => ({ where: () => Promise.resolve(selectRows) }) }),
        execute: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
    },
    sql: vi.fn(),
    eq: vi.fn(),
    inArray: vi.fn(),
    modelsKnowledge: {
        provider: 'provider', modelId: 'model_id', contextWindow: 'context_window',
        costPerMIn: 'cost_per_m_in', costPerMOut: 'cost_per_m_out', strengths: 'strengths',
        reliabilityScore: 'reliability_score',
    },
}))

const stubModel = { __stub: true }
vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn(() => stubModel), createOpenAI: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn(() => stubModel), createAnthropic: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/mistral', () => ({ createMistral: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/groq', () => ({ createGroq: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/xai', () => ({ createXai: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: vi.fn(() => () => stubModel) }))
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: vi.fn(() => () => stubModel) }))

import { _resetProviderBreakerForTest, type WorkspaceAISettings } from '../../registry.js'
import { routeAndCall, _resetStatsForTest } from '../index.js'

const settings = (): WorkspaceAISettings => ({
    primaryProvider: 'anthropic',
    fallbackChain: ['groq'],
    providers: {
        anthropic: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6', enabled: true },
        groq: { provider: 'groq', apiKey: 'sk-groq-test', model: 'llama-3.3-70b', enabled: true },
    },
} as unknown as WorkspaceAISettings)

beforeEach(async () => {
    _resetProviderBreakerForTest()
    _resetStatsForTest()
    selectRows = []
    const { _drainOpsEventQueueForTest } = await import('../error-classifier.js')
    const { _resetAuthEventsForTest } = await import('../auth-events.js')
    const { _resetQualityWarningsForTest } = await import('../quality-warnings.js')
    _drainOpsEventQueueForTest()
    _resetAuthEventsForTest()
    _resetQualityWarningsForTest()
})

afterEach(() => {
    delete process.env.PLEXO_MODEL_ROUTER
})

describe('model-granular cascade (flag ON)', () => {
    it('a failing top model cascades to the next ranked model', async () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        const seen: string[] = []
        let calls = 0
        const result = await routeAndCall({
            workspaceId: undefined,
            taskType: 'planning',
            settings: settings(),
            doCall: async (m) => {
                void m
                calls++
                // The router builds the chosen model; we can't read it off the stub,
                // so track by call order: top pick (anthropic, prior 5) fails first.
                if (calls === 1) { seen.push('first'); throw new Error('503 service unavailable') }
                seen.push('second')
                return 'ok'
            },
        })
        expect(result).toBe('ok')
        expect(calls).toBe(2) // cascaded from the failed top model to the next
    })

    it('flag OFF still serves (no model routing)', async () => {
        delete process.env.PLEXO_MODEL_ROUTER
        const result = await routeAndCall({
            workspaceId: undefined,
            taskType: 'planning',
            settings: settings(),
            doCall: async () => 'ok',
        })
        expect(result).toBe('ok')
    })
})
