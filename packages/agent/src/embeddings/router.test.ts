import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
    resolveEmbeddingAdapter,
    resolveEmbeddingAdapterFromEnv,
    resolveEmbeddingAdapterAsync,
    checkDimensionCompatibility,
    checkProviderLineage,
} from './router.js'

const ENV_VARS = ['EMBEDDINGS_URL', 'EMBEDDINGS_SERVER_URL', 'INFERENCE_GATEWAY_URL'] as const
const originalEnv: Partial<Record<typeof ENV_VARS[number], string | undefined>> = {}

beforeEach(() => {
    for (const k of ENV_VARS) {
        originalEnv[k] = process.env[k]
        delete process.env[k]
    }
})

afterEach(() => {
    for (const k of ENV_VARS) {
        if (originalEnv[k] === undefined) delete process.env[k]
        else process.env[k] = originalEnv[k]
    }
})

describe('resolveEmbeddingAdapter (gateway-only)', () => {
    it('returns the gateway adapter at 384 dims regardless of workspace settings', () => {
        const result = resolveEmbeddingAdapter('ws-1', null)
        expect(result.status).toBe('active')
        expect(result.providerId).toBe('plexo-gateway')
        expect(result.dimensions).toBe(384)
        expect(result.model).toBe('plexo-embed-v1')
        expect(result.adapter).not.toBeNull()
    })

    it('honours EMBEDDINGS_URL', () => {
        process.env.EMBEDDINGS_URL = 'http://override:9000'
        const result = resolveEmbeddingAdapter('ws-1', null)
        expect(result.status).toBe('active')
        expect(result.providerId).toBe('plexo-gateway')
    })

    it('falls back to EMBEDDINGS_SERVER_URL then INFERENCE_GATEWAY_URL', () => {
        process.env.EMBEDDINGS_SERVER_URL = 'http://srv:1'
        const a = resolveEmbeddingAdapter('ws', null)
        expect(a.providerId).toBe('plexo-gateway')
        delete process.env.EMBEDDINGS_SERVER_URL
        process.env.INFERENCE_GATEWAY_URL = 'http://gw:2'
        const b = resolveEmbeddingAdapter('ws', null)
        expect(b.providerId).toBe('plexo-gateway')
    })

    it('resolveEmbeddingAdapterFromEnv is identical', () => {
        const result = resolveEmbeddingAdapterFromEnv('ws-1')
        expect(result.status).toBe('active')
        expect(result.providerId).toBe('plexo-gateway')
    })

    it('resolveEmbeddingAdapterAsync resolves to the gateway', async () => {
        const result = await resolveEmbeddingAdapterAsync('ws-1')
        expect(result.status).toBe('active')
        expect(result.providerId).toBe('plexo-gateway')
        expect(result.dimensions).toBe(384)
    })
})

describe('checkDimensionCompatibility', () => {
    it('is compatible when no existing dimensions', () => {
        const r = checkDimensionCompatibility(384, null)
        expect(r.compatible).toBe(true)
    })

    it('is compatible when dimensions match', () => {
        const r = checkDimensionCompatibility(384, 384)
        expect(r.compatible).toBe(true)
    })

    it('is incompatible when dimensions differ', () => {
        const r = checkDimensionCompatibility(384, 1024)
        expect(r.compatible).toBe(false)
        expect(r.message).toContain('mismatch')
    })
})

describe('checkProviderLineage', () => {
    it('detects no change when no lineage recorded', () => {
        const r = checkProviderLineage('plexo-gateway', 384, {})
        expect(r.providerChanged).toBe(false)
    })

    it('detects provider change with same dimensions', () => {
        const r = checkProviderLineage('plexo-gateway', 384, {
            embeddingProvider: 'xenova-multilingual-e5-small',
            embeddingDimensions: 384,
        })
        expect(r.providerChanged).toBe(true)
        expect(r.message).toContain('Warning')
    })

    it('no change when same provider', () => {
        const r = checkProviderLineage('plexo-gateway', 384, {
            embeddingProvider: 'plexo-gateway',
            embeddingDimensions: 384,
        })
        expect(r.providerChanged).toBe(false)
        expect(r.compatible).toBe(true)
    })
})
