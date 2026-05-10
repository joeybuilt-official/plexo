// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tests for the memory.embeddings + memory.cluster PAX HTTP endpoints.
 *
 * Mocks the underlying agent module so we don't load the ONNX runtime
 * inside the API test process. Covers happy path + empty-input edge for
 * each of the three endpoints, plus service-key auth bouncing.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

vi.mock('@plexo/agent/memory/embeddings', () => ({
    embedAsArrays: vi.fn(async (texts: string[]) => texts.map(t => [t.length / 100, 0.1, 0.2, 0.3])),
}))

vi.mock('@plexo/agent/memory/cluster-api', () => ({
    cluster: vi.fn(async (items: Array<{ id: string; vector: number[] }>) => ({
        assignments: items.map((it, i) => ({ id: it.id, clusterId: i % 2, score: 0.9 })),
        clusters: [
            { clusterId: 0, size: items.length, centroid: [0, 0, 0], coherence: 0.9, memberIds: items.map(i => i.id) },
        ],
        noise: [],
        method: 'kmeans' as const,
        chosenK: 2,
        durationMs: 1,
    })),
    topicLabel: vi.fn(async () => ({ label: 'Test cluster', summary: 'rationale', source: 'haiku' as const })),
}))

import { memoryPaxRouter } from '../memory-pax.js'

const SERVICE_KEY = 'pax-test-secret-key'

let server: Server
let baseUrl = ''

beforeAll(async () => {
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
    const app = express()
    app.use(express.json({ limit: '4mb' }))
    app.use('/api/v1/memory', memoryPaxRouter)

    await new Promise<void>(resolve => {
        server = app.listen(0, () => resolve())
    })
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(() => {
    vi.clearAllMocks()
})

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

const authHeaders = () => ({ Authorization: `Bearer ${SERVICE_KEY}`, 'X-App-Id': 'nexalog' })

describe('POST /api/v1/memory/embeddings', () => {
    it('rejects without a service key', async () => {
        const r = await postJson('/api/v1/memory/embeddings', { texts: ['hi'] })
        expect(r.status).toBe(401)
    })

    it('embeds a batch of strings', async () => {
        const r = await postJson('/api/v1/memory/embeddings', { texts: ['one', 'two', 'three'] }, authHeaders())
        expect(r.status).toBe(200)
        const body = await r.json() as { vectors: number[][]; dimensions: number; count: number }
        expect(body.count).toBe(3)
        expect(body.dimensions).toBe(4)
        expect(body.vectors).toHaveLength(3)
    })

    it('returns an empty payload for an empty input array', async () => {
        const r = await postJson('/api/v1/memory/embeddings', { texts: [] }, authHeaders())
        expect(r.status).toBe(200)
        const body = await r.json() as { vectors: unknown[]; count: number }
        expect(body.count).toBe(0)
        expect(body.vectors).toEqual([])
    })

    it('rejects non-array texts', async () => {
        const r = await postJson('/api/v1/memory/embeddings', { texts: 'not-array' }, authHeaders())
        expect(r.status).toBe(400)
        const body = await r.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_INPUT')
    })
})

describe('POST /api/v1/memory/cluster/compute', () => {
    it('rejects without a service key', async () => {
        const r = await postJson('/api/v1/memory/cluster/compute', { items: [] })
        expect(r.status).toBe(401)
    })

    it('returns an empty cluster envelope for an empty items array', async () => {
        const r = await postJson('/api/v1/memory/cluster/compute', { items: [] }, authHeaders())
        expect(r.status).toBe(200)
        const body = await r.json() as { clusters: unknown[]; assignments: unknown[]; noise: unknown[] }
        expect(body.clusters).toEqual([])
        expect(body.assignments).toEqual([])
        expect(body.noise).toEqual([])
    })

    it('clusters provided items', async () => {
        const items = [
            { id: 'a', vector: [1, 0, 0, 0] },
            { id: 'b', vector: [0.99, 0.01, 0, 0] },
            { id: 'c', vector: [-1, 0, 0, 0] },
            { id: 'd', vector: [-0.99, 0.02, 0, 0] },
        ]
        const r = await postJson('/api/v1/memory/cluster/compute', { items, method: 'kmeans', k: 2 }, authHeaders())
        expect(r.status).toBe(200)
        const body = await r.json() as { assignments: unknown[]; clusters: unknown[] }
        expect(body.assignments).toHaveLength(4)
        expect(body.clusters.length).toBeGreaterThan(0)
    })

    it('rejects mismatched vector dimensions', async () => {
        const r = await postJson('/api/v1/memory/cluster/compute', {
            items: [
                { id: 'a', vector: [1, 0] },
                { id: 'b', vector: [1, 0, 0] },
            ],
        }, authHeaders())
        expect(r.status).toBe(400)
    })
})

describe('POST /api/v1/memory/cluster/label', () => {
    it('rejects without a service key', async () => {
        const r = await postJson('/api/v1/memory/cluster/label', { contents: ['x'] })
        expect(r.status).toBe(401)
    })

    it('labels a non-empty cluster', async () => {
        const r = await postJson('/api/v1/memory/cluster/label', {
            contents: ['Marketing budget review Q3', 'Marketing spend reconciliation'],
        }, authHeaders())
        expect(r.status).toBe(200)
        const body = await r.json() as { label: string; source: string }
        expect(body.label).toBe('Test cluster')
        expect(['haiku', 'ctfidf']).toContain(body.source)
    })

    it('returns a placeholder for empty contents', async () => {
        const r = await postJson('/api/v1/memory/cluster/label', { contents: [] }, authHeaders())
        expect(r.status).toBe(200)
        const body = await r.json() as { label: string; source: string }
        expect(body.label).toBe('Empty cluster')
        expect(body.source).toBe('ctfidf')
    })
})
