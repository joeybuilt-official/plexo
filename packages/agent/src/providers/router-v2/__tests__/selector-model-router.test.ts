// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 Round-6 Phase 2 — model-level routing branch in selectModel.
 * selector.ts is pure (no db); flags are env-driven.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { selectModel, type AvailableProvider } from '../selector.js'
import type { ModelCandidate } from '../candidate.js'
import type { WorkspaceAISettings } from '../../registry.js'

const ap = (provider: string, model?: string): AvailableProvider =>
    ({ provider, config: { provider, model } } as unknown as AvailableProvider)

const baseSettings = (over: Partial<WorkspaceAISettings> = {}): WorkspaceAISettings =>
    ({ providers: {}, primaryProvider: 'anthropic', fallbackChain: [], ...over } as unknown as WorkspaceAISettings)

const cand = (provider: string, modelId: string, prior: number, reliability = 1, costPerMIn = 1): ModelCandidate =>
    ({
        provider: provider as never,
        modelId,
        capabilities: new Set() as never,
        contextWindow: 0,
        costPerMIn,
        costPerMOut: 0,
        reliability,
        priorScoreByTask: { planning: prior, extraction: prior } as never,
    })

afterEach(() => {
    delete process.env.PLEXO_MODEL_ROUTER
})

describe('selectModel — flag OFF', () => {
    it('ignores modelCandidates and uses legacy provider selection (byte-identical)', () => {
        delete process.env.PLEXO_MODEL_ROUTER
        const out = selectModel({
            workspaceId: undefined,
            taskType: 'planning',
            availableProviders: [ap('anthropic', 'claude-sonnet-4-6')],
            settings: baseSettings(),
            modelCandidates: [cand('groq', 'some-cheap-model', 5)],
        })
        // legacy path picks the manifested provider (anthropic), NOT the candidate
        expect(out.chosen?.provider).toBe('anthropic')
        expect(out.modelRouted).toBeUndefined()
    })
})

describe('selectModel — flag ON', () => {
    it('returns the best MODEL across candidates', () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        const out = selectModel({
            workspaceId: undefined,
            taskType: 'planning',
            availableProviders: [ap('anthropic', 'claude-sonnet-4-6'), ap('deepseek', 'deepseek-v3')],
            settings: baseSettings(),
            modelCandidates: [cand('deepseek', 'deepseek-v3', 3), cand('anthropic', 'claude-sonnet-4-6', 5)],
        })
        expect(out.modelRouted).toBe(true)
        expect(out.chosen?.provider).toBe('anthropic')
        expect(out.chosen?.model).toBe('claude-sonnet-4-6')
    })

    it('an explicit per-task model override disables auto-routing (decision #2)', () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        const settings = baseSettings({
            providers: { anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-6' } } as never,
            modelOverrides: { planning: 'claude-opus-4-7' } as never,
        })
        const out = selectModel({
            workspaceId: undefined,
            taskType: 'planning',
            availableProviders: [ap('anthropic', 'claude-sonnet-4-6')],
            settings,
            modelCandidates: [cand('anthropic', 'claude-sonnet-4-6', 5)],
        })
        expect(out.modelRouted).toBeUndefined()
        // legacy path honors the explicit override
        expect(out.chosen?.model).toBe('claude-opus-4-7')
    })

    it('still serves on a single-provider workspace', () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        const out = selectModel({
            workspaceId: undefined,
            taskType: 'extraction',
            availableProviders: [ap('groq', 'llama-3.3-70b')],
            settings: baseSettings({ primaryProvider: 'groq' }),
            modelCandidates: [cand('groq', 'llama-3.3-70b', 4)],
        })
        expect(out.chosen?.provider).toBe('groq')
        expect(out.modelRouted).toBe(true)
    })

    it('D2 modelIdOverride still wins over auto-routing', () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        const settings = baseSettings({
            providers: { anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-6' } } as never,
        })
        const out = selectModel({
            workspaceId: undefined,
            taskType: 'planning',
            availableProviders: [ap('anthropic', 'claude-sonnet-4-6')],
            settings,
            modelIdOverride: 'anthropic/claude-haiku-4-5',
            modelCandidates: [cand('anthropic', 'claude-sonnet-4-6', 5)],
        })
        expect(out.forcedModel).toBe(true)
        expect(out.modelRouted).toBeUndefined()
        expect(out.chosen?.model).toBe('claude-haiku-4-5')
    })

    it('falls through to legacy selection when no candidates supplied', () => {
        process.env.PLEXO_MODEL_ROUTER = '1'
        const out = selectModel({
            workspaceId: undefined,
            taskType: 'planning',
            availableProviders: [ap('anthropic', 'claude-sonnet-4-6')],
            settings: baseSettings(),
        })
        expect(out.modelRouted).toBeUndefined()
        expect(out.chosen?.provider).toBe('anthropic')
    })
})
