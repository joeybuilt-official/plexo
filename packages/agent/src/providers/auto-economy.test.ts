// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import {
    CHEAP_MODEL_BY_PROVIDER,
    MECHANICAL_TASK_TYPES,
    resolveEffectiveModelId,
    type AIProviderConfig,
    type TaskType,
    type WorkspaceAISettings,
} from './registry.js'

function settings(overrides: Partial<WorkspaceAISettings> = {}): WorkspaceAISettings {
    return {
        primaryProvider: 'anthropic',
        fallbackChain: [],
        providers: { anthropic: { provider: 'anthropic' } },
        ...overrides,
    }
}

function config(overrides: Partial<AIProviderConfig> = {}): AIProviderConfig {
    return { provider: 'anthropic', ...overrides }
}

describe('MECHANICAL_TASK_TYPES', () => {
    it('covers the cheap-suitable mechanical types only', () => {
        expect([...MECHANICAL_TASK_TYPES].sort()).toEqual(
            ['classification', 'extraction', 'logAnalysis', 'summarization'],
        )
        expect(MECHANICAL_TASK_TYPES.has('planning')).toBe(false)
        expect(MECHANICAL_TASK_TYPES.has('codeGeneration')).toBe(false)
        expect(MECHANICAL_TASK_TYPES.has('verification')).toBe(false)
        expect(MECHANICAL_TASK_TYPES.has('conversation')).toBe(false)
    })
})

describe('resolveEffectiveModelId (auto-economy)', () => {
    const econ = { inferenceMode: 'auto-economy' as const }

    it('routes a mechanical task to the provider cheap model', () => {
        const out = resolveEffectiveModelId('anthropic', config(), 'classification', settings(econ))
        expect(out).toBe('claude-haiku-4-5')
    })

    it('uses a per-provider cheap model (openai, google)', () => {
        expect(resolveEffectiveModelId('openai', config({ provider: 'openai' }), 'extraction', settings({ ...econ, providers: { openai: { provider: 'openai' } } }))).toBe('gpt-4o-mini')
        expect(resolveEffectiveModelId('google', config({ provider: 'google' }), 'summarization', settings({ ...econ, providers: { google: { provider: 'google' } } }))).toBe('gemini-2.5-flash')
    })

    it('does NOT cheap-route high-stakes or conversational types', () => {
        for (const t of ['planning', 'codeGeneration', 'verification', 'conversation'] as TaskType[]) {
            expect(resolveEffectiveModelId('anthropic', config(), t, settings(econ))).toBe('claude-sonnet-4-6')
        }
    })

    it('is inert in the other inference modes', () => {
        for (const mode of ['auto', 'byok', 'proxy', 'override'] as const) {
            const s = settings({ inferenceMode: mode })
            expect(resolveEffectiveModelId('anthropic', config(), 'classification', s)).toBe('claude-sonnet-4-6')
        }
    })

    it('lets an explicit modelOverrides[taskType] pin win over the cheap map', () => {
        const s = settings({ ...econ, modelOverrides: { classification: 'claude-opus-4-5' } })
        expect(resolveEffectiveModelId('anthropic', config(), 'classification', s)).toBe('claude-opus-4-5')
    })

    it('lets a provider config.model win over the cheap map', () => {
        expect(resolveEffectiveModelId('anthropic', config({ model: 'claude-sonnet-4-5' }), 'classification', settings(econ))).toBe('claude-sonnet-4-5')
    })

    it('falls through to provider default when the provider has no cheap entry', () => {
        const s = settings({ ...econ, providers: { fal: { provider: 'fal' } } })
        expect(resolveEffectiveModelId('fal', config({ provider: 'fal' }), 'classification', s)).toBe('fal-ai/flux/schnell')
    })
})

describe('CHEAP_MODEL_BY_PROVIDER', () => {
    it('maps the flagship cheap models', () => {
        expect(CHEAP_MODEL_BY_PROVIDER.anthropic).toBe('claude-haiku-4-5')
        expect(CHEAP_MODEL_BY_PROVIDER.openai).toBe('gpt-4o-mini')
        expect(CHEAP_MODEL_BY_PROVIDER.google).toBe('gemini-2.5-flash')
        expect(CHEAP_MODEL_BY_PROVIDER.groq).toBe('llama-3.1-8b-instant')
        expect(CHEAP_MODEL_BY_PROVIDER.deepseek).toBe('deepseek-chat')
    })
})