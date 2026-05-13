// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { modelSupportsVision, findVisionCapableModel } from './vision.js'
import type { WorkspaceAISettings, AIProviderConfig, ProviderKey } from './registry.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AIProviderConfig> & { provider: ProviderKey; capabilities?: { chatModels?: string[] } }): AIProviderConfig {
    return {
        enabled: true,
        ...overrides,
    } as AIProviderConfig
}

function makeSettings(opts: {
    primary: ProviderKey
    chain: ProviderKey[]
    providers: Partial<Record<ProviderKey, AIProviderConfig>>
}): WorkspaceAISettings {
    return {
        primaryProvider: opts.primary,
        fallbackChain: opts.chain,
        providers: opts.providers,
    }
}

// ── modelSupportsVision ──────────────────────────────────────────────────────

describe('modelSupportsVision', () => {
    describe('exact matches in VISION_MODELS set', () => {
        const knownVisionModels = [
            // Anthropic
            'claude-opus-4-5',
            'claude-sonnet-4-5',
            'claude-haiku-4-5',
            'claude-opus-4-6',
            'claude-sonnet-4-6',
            // OpenAI
            'gpt-4o',
            'gpt-4o-mini',
            'gpt-4-turbo',
            'gpt-4-vision-preview',
            'o1',
            'o3',
            'o4-mini',
            // Google
            'gemini-2.5-flash',
            'gemini-2.5-pro',
            'gemini-2.0-flash-001',
            'gemini-1.5-flash',
            'gemini-1.5-pro',
            // xAI
            'grok-3',
            'grok-3-mini',
            'grok-2',
            // Groq vision
            'llama-3.2-11b-vision-preview',
            'llama-3.2-90b-vision-preview',
            'meta-llama/llama-4-scout-17b-16e-instruct',
            'meta-llama/llama-4-maverick-17b-128e-instruct',
        ]

        for (const model of knownVisionModels) {
            it(`returns true for ${model}`, () => {
                expect(modelSupportsVision(model)).toBe(true)
            })
        }
    })

    describe('NO_VISION_PROVIDERS fast-path rejection', () => {
        it('rejects deepseek models when provider=deepseek', () => {
            expect(modelSupportsVision('deepseek-chat', 'deepseek')).toBe(false)
            expect(modelSupportsVision('deepseek-reasoner', 'deepseek')).toBe(false)
            expect(modelSupportsVision('deepseek-coder', 'deepseek')).toBe(false)
        })

        it('rejects mistral models when provider=mistral', () => {
            expect(modelSupportsVision('mistral-large-latest', 'mistral')).toBe(false)
            expect(modelSupportsVision('mistral-small-latest', 'mistral')).toBe(false)
            expect(modelSupportsVision('codestral-latest', 'mistral')).toBe(false)
        })

        it('deepseek model WITHOUT provider hint falls through to heuristic (returns false for plain names)', () => {
            expect(modelSupportsVision('deepseek-chat')).toBe(false)
            expect(modelSupportsVision('deepseek-reasoner')).toBe(false)
        })
    })

    describe('heuristic matching', () => {
        it('"vision" in name', () => {
            expect(modelSupportsVision('some-custom-vision-model')).toBe(true)
        })

        it('"-vl" in name (Qwen-VL style)', () => {
            expect(modelSupportsVision('qwen2-72b-vl')).toBe(true)
            expect(modelSupportsVision('qwen-vl-max')).toBe(true)
        })

        it('"llava" in name', () => {
            expect(modelSupportsVision('llava-1.6-34b')).toBe(true)
            expect(modelSupportsVision('llava:latest')).toBe(true)
        })

        it('"pixtral" in name', () => {
            expect(modelSupportsVision('pixtral-large-latest')).toBe(true)
            expect(modelSupportsVision('pixtral-12b-2409')).toBe(true)
        })

        it('case-insensitive heuristic', () => {
            expect(modelSupportsVision('Some-VISION-Model')).toBe(true)
            expect(modelSupportsVision('LLAVA-34B')).toBe(true)
        })
    })

    describe('OpenRouter compound IDs', () => {
        it('resolves anthropic/claude-sonnet-4-5 via slash stripping', () => {
            expect(modelSupportsVision('anthropic/claude-sonnet-4-5')).toBe(true)
        })

        it('resolves openai/gpt-4o', () => {
            expect(modelSupportsVision('openai/gpt-4o')).toBe(true)
        })

        it('resolves google/gemini-2.5-flash', () => {
            expect(modelSupportsVision('google/gemini-2.5-flash')).toBe(true)
        })

        it('heuristic works through slash: vendor/some-vision-model', () => {
            expect(modelSupportsVision('vendor/some-vision-model')).toBe(true)
        })

        it('returns false for unknown compound ID: vendor/unknown-text-model', () => {
            expect(modelSupportsVision('vendor/unknown-text-model')).toBe(false)
        })
    })

    describe('unknown models return false', () => {
        it('random string', () => {
            expect(modelSupportsVision('llama-3.3-70b-versatile')).toBe(false)
        })

        it('empty string', () => {
            expect(modelSupportsVision('')).toBe(false)
        })

        it('close but not matching: "visual" does not trigger', () => {
            expect(modelSupportsVision('visual-model-v1')).toBe(false)
        })
    })
})

// ── findVisionCapableModel ───────────────────────────────────────────────────

describe('findVisionCapableModel', () => {
    const defaultModels: Partial<Record<string, string>> = {
        anthropic: 'claude-sonnet-4-5',
        openai: 'gpt-4o',
        groq: 'llama-3.3-70b-versatile',
        deepseek: 'deepseek-chat',
    }

    it('finds vision from selected model (claude-opus-4-5)', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['anthropic'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-4-5' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toEqual({ providerKey: 'anthropic', modelId: 'claude-opus-4-5' })
    })

    it('finds vision from selected model (gpt-4o)', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['openai'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toEqual({ providerKey: 'openai', modelId: 'gpt-4o' })
    })

    it('finds vision from default model when no explicit model set', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['openai'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai' }), // no model → uses defaultModels
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toEqual({ providerKey: 'openai', modelId: 'gpt-4o' })
    })

    it('finds vision from discovered capabilities when selected model is text-only', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['groq'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                groq: makeConfig({
                    provider: 'groq',
                    apiKey: 'gsk_xxx',
                    model: 'llama-3.3-70b-versatile',
                    capabilities: { chatModels: ['llama-3.3-70b-versatile', 'llama-3.2-90b-vision-preview', 'mixtral-8x7b'] },
                }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toEqual({ providerKey: 'groq', modelId: 'llama-3.2-90b-vision-preview' })
    })

    it('does NOT use hardcoded fallback when discovery ran but found no vision models', () => {
        // If discovery ran and returned models but none are vision-capable,
        // the hardcoded fallback is skipped — the model genuinely isn't available.
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['groq'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                groq: makeConfig({
                    provider: 'groq',
                    apiKey: 'gsk_xxx',
                    model: 'llama-3.3-70b-versatile',
                    capabilities: { chatModels: ['llama-3.3-70b-versatile', 'mixtral-8x7b'] },
                }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toBeNull()
    })

    it('returns null for provider with no capabilities and non-vision selected model', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['groq'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                groq: makeConfig({ provider: 'groq', apiKey: 'gsk_xxx', model: 'llama-3.3-70b-versatile' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toBeNull()
    })

    it('skips the primary provider', () => {
        const settings = makeSettings({
            primary: 'anthropic',
            chain: ['openai'],
            providers: {
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-sonnet-4-5' }),
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o' }),
            },
        })

        // Skip anthropic — should pick openai
        const result = findVisionCapableModel(settings, defaultModels, 'anthropic')
        expect(result).toEqual({ providerKey: 'openai', modelId: 'gpt-4o' })
    })

    it('skips disabled providers', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['anthropic', 'openai'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-sonnet-4-5', enabled: false }),
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toEqual({ providerKey: 'openai', modelId: 'gpt-4o' })
    })

    it('returns null when no vision model exists anywhere', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['mistral'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                mistral: makeConfig({ provider: 'mistral', apiKey: 'sk-mis', model: 'mistral-large-latest' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toBeNull()
    })

    it('handles NO_VISION_PROVIDERS correctly — deepseek skipped by modelSupportsVision', () => {
        const settings = makeSettings({
            primary: 'anthropic',
            chain: ['deepseek'],
            providers: {
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-sonnet-4-5' }),
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-chat' }),
            },
        })

        // Skip anthropic; deepseek is the only fallback but it's no-vision
        const result = findVisionCapableModel(settings, defaultModels, 'anthropic')
        expect(result).toBeNull()
    })

    it('respects fallback chain order — skips non-vision provider, finds first vision-capable', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['groq', 'anthropic', 'openai'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                groq: makeConfig({ provider: 'groq', apiKey: 'gsk_xxx', model: 'llama-3.3-70b-versatile' }),
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-sonnet-4-5' }),
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o' }),
            },
        })

        // Groq's selected model has no vision, no capabilities → skipped
        // Anthropic's claude-sonnet-4-5 is vision-capable → wins
        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toEqual({ providerKey: 'anthropic', modelId: 'claude-sonnet-4-5' })
    })

    it('providers not in fallbackChain are still checked (appended after chain)', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['mistral'], // mistral has no vision
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                mistral: makeConfig({ provider: 'mistral', apiKey: 'sk-mis', model: 'mistral-large-latest' }),
                // openai not in chain but is in providers
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toEqual({ providerKey: 'openai', modelId: 'gpt-4o' })
    })
})

// ── Production scenario simulation ───────────────────────────────────────────

describe('production scenario: deepseek primary, anthropic vision fallback', () => {
    it('deepseek-reasoner → groq (text-only, discovery ran, no vision) → skips groq → anthropic wins', () => {
        // User setup:
        //   primary = deepseek-reasoner (no vision)
        //   Groq has key, selected = llama-3.3-70b-versatile (no vision)
        //   Groq discovered models don't include vision models (discovery DID run)
        //   Anthropic has key, claude-opus-4-5 (vision) — appears after groq in chain
        // Since Groq's discovery ran and found no vision models, the hardcoded
        // fallback is NOT used — Anthropic is the correct vision provider.
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['groq', 'anthropic'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                groq: makeConfig({
                    provider: 'groq',
                    apiKey: 'gsk_xxx',
                    model: 'llama-3.3-70b-versatile',
                    capabilities: { chatModels: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'] },
                }),
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-4-5' }),
            },
        })

        const defaultModels: Partial<Record<string, string>> = {
            deepseek: 'deepseek-chat',
            groq: 'llama-3.3-70b-versatile',
            anthropic: 'claude-sonnet-4-5',
        }

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')

        // Groq's discovery ran → found no vision models → hardcoded fallback skipped →
        // Anthropic (claude-opus-4-5) is found as the vision provider
        expect(result).toEqual({ providerKey: 'anthropic', modelId: 'claude-opus-4-5' })
    })

    it('groq with no apiKey and no baseUrl is skipped → anthropic wins', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['groq', 'anthropic'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                groq: makeConfig({
                    provider: 'groq',
                    // no apiKey, no baseUrl
                    model: 'llama-3.3-70b-versatile',
                }),
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-4-5' }),
            },
        })

        const defaultModels: Partial<Record<string, string>> = {
            groq: 'llama-3.3-70b-versatile',
            anthropic: 'claude-sonnet-4-5',
        }

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        // Groq selected model not vision, no capabilities → skipped
        // → anthropic's claude-opus-4-5 wins
        expect(result).toEqual({ providerKey: 'anthropic', modelId: 'claude-opus-4-5' })
    })
})

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('edge cases', () => {
    const defaultModels: Partial<Record<string, string>> = {
        anthropic: 'claude-sonnet-4-5',
        openai: 'gpt-4o',
        groq: 'llama-3.3-70b-versatile',
    }

    it('provider with no apiKey and no baseUrl — non-vision model skipped', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['groq'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                groq: makeConfig({ provider: 'groq', model: 'llama-3.3-70b-versatile' }),
                // groq has no apiKey, no baseUrl
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        // Selected model not vision, no capabilities → null
        expect(result).toBeNull()
    })

    it('provider with capabilities but empty chatModels array', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['groq'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                groq: makeConfig({
                    provider: 'groq',
                    apiKey: 'gsk_xxx',
                    model: 'llama-3.3-70b-versatile',
                    capabilities: { chatModels: [] },
                }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        // Empty chatModels → no discovered vision → no hardcoded fallback → null
        expect(result).toBeNull()
    })

    it('multiple providers with vision — first in chain wins', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['openai', 'anthropic'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o' }),
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-4-5' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toEqual({ providerKey: 'openai', modelId: 'gpt-4o' })

        // Reverse chain order → anthropic wins
        const settings2 = makeSettings({
            primary: 'deepseek',
            chain: ['anthropic', 'openai'],
            providers: settings.providers,
        })
        const result2 = findVisionCapableModel(settings2, defaultModels, 'deepseek')
        expect(result2).toEqual({ providerKey: 'anthropic', modelId: 'claude-opus-4-5' })
    })

    it('all providers disabled except one with non-vision model → null', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['anthropic', 'openai', 'groq'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-sonnet-4-5', enabled: false }),
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o', enabled: false }),
                groq: makeConfig({ provider: 'groq', apiKey: 'gsk_xxx', model: 'llama-3.3-70b-versatile' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        // anthropic disabled, openai disabled → groq's selected model not vision,
        // no capabilities → null
        expect(result).toBeNull()
    })

    it('provider config is undefined in providers map → skipped gracefully', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['anthropic', 'openai'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                // anthropic referenced in chain but not in providers
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        expect(result).toEqual({ providerKey: 'openai', modelId: 'gpt-4o' })
    })

    it('no skipProvider — primary is checked too', () => {
        const settings = makeSettings({
            primary: 'anthropic',
            chain: ['openai'],
            providers: {
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-4-5' }),
                openai: makeConfig({ provider: 'openai', apiKey: 'sk-oai', model: 'gpt-4o' }),
            },
        })

        // No skipProvider → anthropic is in fallbackChain (excluded from chain, but it's in providers keys)
        // Actually anthropic is primaryProvider, not in fallbackChain.
        // But it's in Object.keys(providers) and not in fallbackChain, so it gets appended.
        // Chain = ['openai'] → openai first, then anthropic appended
        // openai has gpt-4o → vision → found
        const result = findVisionCapableModel(settings, defaultModels)
        expect(result).not.toBeNull()
        // openai is in fallbackChain, checked first
        expect(result).toEqual({ providerKey: 'openai', modelId: 'gpt-4o' })
    })

    it('baseUrl (no apiKey) with non-vision model → null', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: ['groq'],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                groq: makeConfig({
                    provider: 'groq',
                    baseUrl: 'https://custom-groq-proxy.example.com',
                    model: 'llama-3.3-70b-versatile',
                } as any),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        // No vision in selected model, no capabilities → null
        expect(result).toBeNull()
    })

    it('empty fallbackChain — only providers map keys searched', () => {
        const settings = makeSettings({
            primary: 'deepseek',
            chain: [],
            providers: {
                deepseek: makeConfig({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-reasoner' }),
                anthropic: makeConfig({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-4-5' }),
            },
        })

        const result = findVisionCapableModel(settings, defaultModels, 'deepseek')
        // Chain empty → providers keys appended: [deepseek, anthropic]
        // deepseek skipped → anthropic found
        expect(result).toEqual({ providerKey: 'anthropic', modelId: 'claude-opus-4-5' })
    })
})
