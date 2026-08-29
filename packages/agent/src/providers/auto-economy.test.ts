// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import {
    CHEAP_MODEL_BY_PROVIDER,
    MECHANICAL_TASK_TYPES,
    resolveEffectiveModelId,
    resolveWeakDelegateModelId,
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

describe('resolveWeakDelegateModelId (B17)', () => {
    it('is off by default — an untouched workspace routes exactly as before', () => {
        expect(resolveWeakDelegateModelId(settings())).toBeUndefined()
        expect(resolveWeakDelegateModelId(settings({ weakDelegateModel: false }))).toBeUndefined()
    })

    it('returns the active provider cheap model as a provider/model override when enabled', () => {
        const out = resolveWeakDelegateModelId(settings({ weakDelegateModel: true }))
        expect(out).toBe(`anthropic/${CHEAP_MODEL_BY_PROVIDER.anthropic}`)
    })

    it('follows primaryProvider rather than assuming anthropic', () => {
        const out = resolveWeakDelegateModelId(settings({
            weakDelegateModel: true,
            primaryProvider: 'openai',
            providers: { openai: { provider: 'openai' } },
        }))
        expect(out).toBe(`openai/${CHEAP_MODEL_BY_PROVIDER.openai}`)
    })

    it('stays silent when the active provider has no cheap model mapped', () => {
        const exotic = { weakDelegateModel: true, primaryProvider: 'nope' } as unknown as WorkspaceAISettings
        expect(resolveWeakDelegateModelId({ ...settings(), ...exotic })).toBeUndefined()
    })

    it('does not leak into resolveEffectiveModelId — the parent loop keeps the strong model', () => {
        // The parent executor loop and spawn_subagent both route at
        // 'codeGeneration'. The split is a call-site override precisely BECAUSE
        // a task-type-keyed rule could not tell them apart, so enabling the flag
        // must not change what resolveEffectiveModelId returns for that type.
        const withFlag = settings({ weakDelegateModel: true })
        const without = settings()
        for (const t of ['codeGeneration', 'planning'] as TaskType[]) {
            expect(resolveEffectiveModelId('anthropic', config(), t, withFlag))
                .toBe(resolveEffectiveModelId('anthropic', config(), t, without))
        }
    })
})
