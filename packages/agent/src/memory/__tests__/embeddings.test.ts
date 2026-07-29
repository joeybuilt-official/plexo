// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tests for `memory.embeddings` — the shared embedding façade.
 *
 * The Xenova ONNX path is mocked so unit tests don't download the model.
 * We exercise: single-string, batch, empty-input, cache hit, cache reset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakeAdapter = {
    providerId: 'test-mock',
    model: 'mock-model',
    dimensions: 4,
    embed: vi.fn(async (text: string) => {
        if (!text.trim()) return [0, 0, 0, 0]
        // Deterministic-ish vector so we can compare across calls
        const sum = [...text].reduce((s, c) => s + c.charCodeAt(0), 0)
        return [sum % 7, sum % 11, sum % 13, sum % 17].map(n => n / 17)
    }),
}

vi.mock('../../embeddings/router.js', () => ({
    resolveEmbeddingAdapterAsync: vi.fn(async () => ({
        adapter: fakeAdapter,
        providerId: fakeAdapter.providerId,
        model: fakeAdapter.model,
        dimensions: fakeAdapter.dimensions,
        status: 'active' as const,
        message: null,
    })),
}))

import { embed, embedAsArray, embedAsArrays, getEmbedder, _resetEmbeddingsCache } from '../embeddings.js'

beforeEach(() => {
    fakeAdapter.embed.mockClear()
    _resetEmbeddingsCache()
})

describe('memory.embeddings.embed', () => {
    it('returns a Float32Array of the adapter dimension for a single string', async () => {
        const v = await embed('hello world')
        expect(v).toBeInstanceOf(Float32Array)
        expect(v.length).toBe(4)
        expect(fakeAdapter.embed).toHaveBeenCalledTimes(1)
    })

    it('returns Float32Array[] for an array of strings', async () => {
        const out = await embed(['a', 'b', 'c'])
        expect(out).toHaveLength(3)
        for (const v of out) {
            expect(v).toBeInstanceOf(Float32Array)
            expect(v.length).toBe(4)
        }
    })

    it('returns a zero vector for empty input without calling the adapter', async () => {
        const v = await embed('')
        expect(v.length).toBe(4)
        for (let i = 0; i < 4; i++) expect(v[i]).toBe(0)
        expect(fakeAdapter.embed).not.toHaveBeenCalled()
    })

    it('returns a zero vector for whitespace-only input', async () => {
        const v = await embed('   \n\t  ')
        for (let i = 0; i < 4; i++) expect(v[i]).toBe(0)
        expect(fakeAdapter.embed).not.toHaveBeenCalled()
    })

    it('caches identical text/provider pairs', async () => {
        await embed('caching test')
        await embed('caching test')
        await embed('caching test')
        expect(fakeAdapter.embed).toHaveBeenCalledTimes(1)
    })

    it('skipCache forces a fresh call', async () => {
        await embed('forced')
        await embed('forced', { skipCache: true })
        expect(fakeAdapter.embed).toHaveBeenCalledTimes(2)
    })

    it('embedAsArray converts to number[] for JSON', async () => {
        const arr = await embedAsArray('json me')
        expect(Array.isArray(arr)).toBe(true)
        expect(arr).toHaveLength(4)
    })

    it('embedAsArrays handles batches', async () => {
        const arrs = await embedAsArrays(['x', 'y'])
        expect(arrs).toHaveLength(2)
        expect(arrs[0]).toHaveLength(4)
    })

    it('getEmbedder returns the resolved adapter + lineage', async () => {
        const r = await getEmbedder()
        expect(r.adapter.dimensions).toBe(4)
        expect(r.resolution.providerId).toBe('test-mock')
        expect(r.resolution.status).toBe('active')
    })
})
