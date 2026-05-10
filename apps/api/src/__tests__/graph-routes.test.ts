// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * HTTP route tests for /api/v1/graph/* (ADR 0009).
 *
 * Pins (8+):
 *   - Each of the 4 routes returns 200 on a valid happy-path request
 *   - Each of the 4 routes returns 401 when the Bearer service key is missing
 *   - Selected input-validation paths return 400
 *
 * graph-query is fully mocked — these tests cover route plumbing only.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const mockGraphMutate = vi.fn()
const mockGraphExpand = vi.fn()
const mockGetGraphMeta = vi.fn()
const mockTriggerGraphExtract = vi.fn()

vi.mock('@plexo/agent/memory/graph-query', () => ({
    graphMutate: mockGraphMutate,
    graphExpand: mockGraphExpand,
    getGraphMeta: mockGetGraphMeta,
    triggerGraphExtract: mockTriggerGraphExtract,
}))

const SERVICE_KEY = 'test-plexo-service-key-12345678901234567890'
const WS = '00000000-0000-0000-0000-000000000001'

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
        const { graphRouter } = await import('../routes/graph.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/graph', graphRouter)

        const created = app.listen(0)
        server = created
        await new Promise<void>((r) => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
    mockGraphMutate.mockReset()
    mockGraphExpand.mockReset()
    mockGetGraphMeta.mockReset()
    mockTriggerGraphExtract.mockReset()
})

afterAll(() => { server?.close() })

function authedHeaders(): Record<string, string> {
    return {
        'content-type': 'application/json',
        authorization: `Bearer ${SERVICE_KEY}`,
        'x-app-id': 'nexalog',
    }
}

describe('POST /api/v1/graph/mutate', () => {
    it('happy path → 200 with mutation result', async () => {
        mockGraphMutate.mockResolvedValueOnce({ nodeIds: ['n1'], created: 1, existing: 0 })
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/mutate`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WS, concepts: [{ label: 'docker' }], source: 'test' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toMatchObject({ ok: true, nodeIds: ['n1'], created: 1, existing: 0 })
        expect(mockGraphMutate).toHaveBeenCalledOnce()
    })

    it('missing Bearer → 401', async () => {
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/mutate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-app-id': 'nexalog' },
            body: JSON.stringify({ workspaceId: WS, concepts: [], source: 'test' }),
        })
        expect(res.status).toBe(401)
        expect(mockGraphMutate).not.toHaveBeenCalled()
    })

    it('invalid workspaceId → 400', async () => {
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/mutate`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: 'not-a-uuid', concepts: [], source: 'test' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('non-array concepts → 400', async () => {
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/mutate`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WS, concepts: 'oops', source: 'test' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error.code).toBe('INVALID_CONCEPTS')
    })
})

describe('POST /api/v1/graph/expand', () => {
    it('happy path → 200 with expansion', async () => {
        mockGraphExpand.mockResolvedValueOnce({
            nodes: [{ id: 'n1', label: 'docker', type: null, depth: 0 }],
            truncated: false,
        })
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/expand`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WS, stimulus: 'docker' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.nodes).toHaveLength(1)
        expect(body.truncated).toBe(false)
    })

    it('missing Bearer → 401', async () => {
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/expand`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, stimulus: 'docker' }),
        })
        expect(res.status).toBe(401)
    })

    it('missing stimulus → 400', async () => {
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/expand`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error.code).toBe('INVALID_STIMULUS')
    })
})

describe('GET /api/v1/graph/meta', () => {
    it('happy path → 200 with counts', async () => {
        mockGetGraphMeta.mockResolvedValueOnce({ nodeCount: 7, edgeCount: 12, lastUpdate: null })
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/meta?workspaceId=${WS}`, {
            method: 'GET',
            headers: authedHeaders(),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.meta.nodeCount).toBe(7)
        expect(body.meta.edgeCount).toBe(12)
    })

    it('missing Bearer → 401', async () => {
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/meta?workspaceId=${WS}`, { method: 'GET' })
        expect(res.status).toBe(401)
    })
})

describe('POST /api/v1/graph/extract/trigger', () => {
    it('happy path → 200', async () => {
        mockTriggerGraphExtract.mockResolvedValueOnce({ ok: true })
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/extract/trigger`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WS, sourceLogId: 'src-1' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({ ok: true })
    })

    it('missing Bearer → 401', async () => {
        const url = await getServer()
        const res = await fetch(`${url}/api/v1/graph/extract/trigger`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(401)
    })
})
