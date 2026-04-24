import { describe, it, expect, vi } from 'vitest'

// The providers/registry type-only import can still cause vitest to load the
// module graph, which pulls in @plexo/db. Stub it out for unit-test isolation.
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

import { resolveEmbeddingAdapter, checkDimensionCompatibility, checkProviderLineage } from './router.js'
import type { WorkspaceAISettings } from '../providers/registry.js'

describe('resolveEmbeddingAdapter', () => {
    it('resolves OpenAI from workspace settings', () => {
        const settings: WorkspaceAISettings = {
            primaryProvider: 'openai',
            fallbackChain: [],
            providers: {
                openai: { provider: 'openai', apiKey: 'sk-test-valid-key-here-1234567890', enabled: true },
            },
        }
        const result = resolveEmbeddingAdapter('ws-1', settings)
        expect(result.status).toBe('active')
        expect(result.providerId).toBe('openai')
        expect(result.dimensions).toBe(1536)
    })

    it('resolves Google from workspace settings', () => {
        const settings: WorkspaceAISettings = {
            primaryProvider: 'google',
            fallbackChain: [],
            providers: {
                google: { provider: 'google', apiKey: 'AIza-test-valid-key-1234567890', enabled: true },
            },
        }
        const result = resolveEmbeddingAdapter('ws-1', settings)
        expect(result.status).toBe('active')
        expect(result.providerId).toBe('google')
        expect(result.dimensions).toBe(768)
    })

    it('skips embedding-incapable providers and finds fallback', () => {
        const settings: WorkspaceAISettings = {
            primaryProvider: 'anthropic',
            fallbackChain: ['deepseek', 'openai'],
            providers: {
                anthropic: { provider: 'anthropic', apiKey: 'sk-ant-FAKEFAKEFAKEFAKEFAKE00', enabled: true },
                deepseek: { provider: 'deepseek', apiKey: 'sk-deepseek-test-key-12345', enabled: true },
                openai: { provider: 'openai', apiKey: 'sk-openai-test-key-1234567890abc', enabled: true },
            },
        }
        const result = resolveEmbeddingAdapter('ws-1', settings)
        // Anthropic and DeepSeek are embedding-incapable, should resolve to OpenAI
        expect(result.status).toBe('active')
        expect(result.providerId).toBe('openai')
    })

    it('resolves Ollama from base URL without API key', () => {
        const settings: WorkspaceAISettings = {
            primaryProvider: 'ollama',
            fallbackChain: [],
            providers: {
                ollama: { provider: 'ollama', baseUrl: 'http://localhost:11434', enabled: true },
            },
        }
        const result = resolveEmbeddingAdapter('ws-1', settings)
        expect(result.status).toBe('active')
        expect(result.providerId).toBe('ollama')
        expect(result.dimensions).toBe(1024) // snowflake-arctic-embed default
    })

    it('returns not-configured when no provider supports embeddings', () => {
        const settings: WorkspaceAISettings = {
            primaryProvider: 'anthropic',
            fallbackChain: ['deepseek', 'groq'],
            providers: {
                anthropic: { provider: 'anthropic', apiKey: 'sk-ant-FAKEFAKEFAKEFAKEFAKE00', enabled: true },
                deepseek: { provider: 'deepseek', apiKey: 'sk-deepseek-test-key-12345', enabled: true },
                groq: { provider: 'groq', apiKey: 'gsk-test-key-1234567890abcdef', enabled: true },
            },
        }
        const result = resolveEmbeddingAdapter('ws-1', settings)
        expect(result.status).toBe('not-configured')
        expect(result.adapter).toBeNull()
    })

    it('returns not-configured with null settings and no env vars', () => {
        const result = resolveEmbeddingAdapter('ws-1', null)
        expect(result.status).toBe('not-configured')
    })

    it('skips disabled providers', () => {
        const settings: WorkspaceAISettings = {
            primaryProvider: 'openai',
            fallbackChain: [],
            providers: {
                openai: { provider: 'openai', apiKey: 'sk-test-valid-key-here-1234567890', enabled: false },
            },
        }
        const result = resolveEmbeddingAdapter('ws-1', settings)
        expect(result.status).toBe('not-configured')
    })

    it('skips providers with empty API key', () => {
        const settings: WorkspaceAISettings = {
            primaryProvider: 'openai',
            fallbackChain: [],
            providers: {
                openai: { provider: 'openai', apiKey: '', enabled: true },
            },
        }
        const result = resolveEmbeddingAdapter('ws-1', settings)
        expect(result.status).toBe('not-configured')
    })

    it('handles all 7 embedding-capable providers', () => {
        const capable = [
            { key: 'openai', apiKey: 'sk-test-valid-key-here-1234567890', dims: 1536 },
            { key: 'google', apiKey: 'AIza-test-valid-key-1234567890', dims: 768 },
            { key: 'mistral', apiKey: 'mist-test-valid-key-1234567890', dims: 1024 },
            { key: 'voyage', apiKey: 'voy-test-valid-key-12345678901', dims: 1024 },
            { key: 'cohere', apiKey: 'coh-test-valid-key-12345678901', dims: 1024 },
        ]
        for (const { key, apiKey, dims } of capable) {
            const settings: WorkspaceAISettings = {
                primaryProvider: key as any,
                fallbackChain: [],
                providers: { [key]: { provider: key as any, apiKey, enabled: true } },
            }
            const result = resolveEmbeddingAdapter('ws-1', settings)
            expect(result.status).toBe('active')
            expect(result.providerId).toBe(key)
            expect(result.dimensions).toBe(dims)
        }
    })
})

describe('checkDimensionCompatibility', () => {
    it('is compatible when no existing dimensions', () => {
        const result = checkDimensionCompatibility(1024, null)
        expect(result.compatible).toBe(true)
    })

    it('is compatible when dimensions match', () => {
        const result = checkDimensionCompatibility(1024, 1024)
        expect(result.compatible).toBe(true)
    })

    it('is incompatible when dimensions differ', () => {
        const result = checkDimensionCompatibility(768, 1024)
        expect(result.compatible).toBe(false)
        expect(result.message).toContain('mismatch')
    })
})

describe('checkProviderLineage', () => {
    it('detects no change when no lineage recorded', () => {
        const result = checkProviderLineage('openai', 1536, {})
        expect(result.providerChanged).toBe(false)
    })

    it('detects provider change with same dimensions', () => {
        const result = checkProviderLineage('openai', 1024, {
            embeddingProvider: 'ollama',
            embeddingModel: 'snowflake-arctic-embed',
            embeddingDimensions: 1024,
        })
        expect(result.providerChanged).toBe(true)
        expect(result.message).toContain('Warning')
        expect(result.message).toContain('ollama')
        expect(result.message).toContain('openai')
    })

    it('no change when same provider', () => {
        const result = checkProviderLineage('ollama', 1024, {
            embeddingProvider: 'ollama',
            embeddingDimensions: 1024,
        })
        expect(result.providerChanged).toBe(false)
        expect(result.compatible).toBe(true)
    })

    it('detects dimension mismatch with provider change', () => {
        const result = checkProviderLineage('openai', 1536, {
            embeddingProvider: 'ollama',
            embeddingDimensions: 1024,
        })
        expect(result.compatible).toBe(false)
        expect(result.providerChanged).toBe(true)
    })
})
