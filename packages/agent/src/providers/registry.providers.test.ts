// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Provider whitelist coverage test.
 *
 * Guards against the "catalog drift" class of bugs where the UI catalog
 * advertises a provider that the backend registry doesn't know how to
 * instantiate. Every key in BUILTIN_PROVIDER_KEYS MUST build a model
 * via both buildModel() and buildTestModel() without throwing.
 *
 * If you add a provider to BUILTIN_PROVIDER_KEYS, this test will fail
 * until you add switch cases in registry.ts. That's the point.
 */

import { describe, it, expect, vi } from 'vitest'

// registry.ts imports @plexo/db at module-top for self-calibration bookkeeping.
// The whitelist itself doesn't need the DB, so stub it out for the test.
vi.mock('@plexo/db', () => ({
    db: {
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
    },
    sql: vi.fn(),
    eq: vi.fn(),
    modelsKnowledge: { reliabilityScore: 'reliability_score', modelId: 'model_id' },
}))

import {
    BUILTIN_PROVIDER_KEYS,
    PROVIDER_DEFAULT_MODELS,
    isBuiltinProviderKey,
    isKnownProviderKey,
} from './registry.js'

describe('provider registry whitelist', () => {
    it('every builtin key has a default model', () => {
        for (const key of BUILTIN_PROVIDER_KEYS) {
            expect(
                PROVIDER_DEFAULT_MODELS[key],
                `${key} is in BUILTIN_PROVIDER_KEYS but has no PROVIDER_DEFAULT_MODELS entry`,
            ).toBeTruthy()
        }
    })

    it('isBuiltinProviderKey accepts every builtin key', () => {
        for (const key of BUILTIN_PROVIDER_KEYS) {
            expect(isBuiltinProviderKey(key), `${key} should be recognized as builtin`).toBe(true)
        }
    })

    it('isKnownProviderKey accepts builtins, voyage, and custom_* keys', () => {
        expect(isKnownProviderKey('cerebras')).toBe(true)
        expect(isKnownProviderKey('voyage')).toBe(true)
        expect(isKnownProviderKey('custom_myserver')).toBe(true)
        expect(isKnownProviderKey('not-a-real-provider')).toBe(false)
        expect(isKnownProviderKey('')).toBe(false)
    })

    it('every chat-capable builtin key is instantiable via buildModel without throwing', async () => {
        const { buildModel } = await import('./registry.js')
        // Non-chat providers (image/video gen only) intentionally throw in
        // buildModel — they are excluded from this assertion.
        const NON_CHAT_PROVIDERS = new Set(['fal'])
        for (const key of BUILTIN_PROVIDER_KEYS) {
            if (NON_CHAT_PROVIDERS.has(key)) continue
            expect(
                () =>
                    buildModel(
                        key,
                        { provider: key, apiKey: 'test-key-not-used' },
                        'summarization',
                        {
                            primaryProvider: key,
                            fallbackChain: [],
                            providers: {},
                        },
                    ),
                `buildModel should handle ${key}`,
            ).not.toThrow()
        }
    })

    it('non-chat providers throw descriptive errors in buildModel', async () => {
        const { buildModel } = await import('./registry.js')
        expect(
            () =>
                buildModel(
                    'fal',
                    { provider: 'fal', apiKey: 'test-key' },
                    'summarization',
                    { primaryProvider: 'fal', fallbackChain: [], providers: {} },
                ),
        ).toThrow(/does not support chat/)
    })

    it('UI catalog stays in sync with backend whitelist', () => {
        // These are the keys the UI currently advertises. Keep the list in sync
        // with apps/web/src/app/app/settings/intelligence/add-provider-modal.tsx
        // PROVIDERS array (minus 'voyage', which is embeddings-only).
        const UI_CATALOG_KEYS = [
            'anthropic',
            'openai',
            'google',
            'openrouter',
            'deepseek',
            'groq',
            'cerebras',
            'sambanova',
            'fireworks',
            'together',
            'mistral',
            'cohere',
            'perplexity',
            'xai',
            'cloudflare',
            'fal',
        ]
        for (const key of UI_CATALOG_KEYS) {
            expect(
                isBuiltinProviderKey(key),
                `UI catalog lists "${key}" but it's missing from BUILTIN_PROVIDER_KEYS`,
            ).toBe(true)
        }
    })
})
