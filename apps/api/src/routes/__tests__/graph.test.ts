// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 8 graph routes — public surface for SDK 1.1.0 addEpisode + searchFacts.
 * Validates auth + payload validation + bridge proxy semantics.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { graphRouter, setGraphRouterClientForTest, resetGraphRouterForTest } from '../graph.js'
import type { GraphitiClient } from '@plexo/graphiti-bridge'

const SERVICE_KEY = 'test-service-key-1234567890abcd'
const VALID_WORKSPACE = '00000000-0000-0000-0000-000000000001'

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const app = express()
        app.use(express.json())
        app.use('/api/v1/graph', graphRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>(r => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
    resetGraphRouterForTest()
    vi.clearAllMocks()
})

afterAll(() => { server?.close() })

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_KEY}`,
        'X-App-Id': 'test-suite',
        ...extra,
    }
}

describe('POST /api/v1/graph/episodes', () => {
    it('proxies to bridge.addEpisode and returns the typed result', async () => {
        const fake = {
            addEpisode: vi.fn(async () => ({ episodeId: 'ep-1', extractedFactsCount: 2, extractedNodesCount: 3 })),
        } as unknown as GraphitiClient
        setGraphRouterClientForTest(fake)

        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/episodes`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: VALID_WORKSPACE, content: 'hello plexo', name: 'test', metadata: { foo: 'bar' } }),
        })
        expect(res.status).toBe(200)
        const out = await res.json()
        expect(out).toEqual({ episodeId: 'ep-1', extractedFactsCount: 2, extractedNodesCount: 3 })
    })

    it('rejects missing/invalid workspaceId (400)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/episodes`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: 'not-a-uuid', content: 'x' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_WORKSPACE_ID')
    })

    it('rejects empty content (400)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/episodes`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: VALID_WORKSPACE, content: '   ' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('EMPTY_CONTENT')
    })

    it('returns 502 when bridge returns null', async () => {
        const fake = { addEpisode: vi.fn(async () => null) } as unknown as GraphitiClient
        setGraphRouterClientForTest(fake)
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/episodes`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: VALID_WORKSPACE, content: 'hello' }),
        })
        expect(res.status).toBe(502)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('BRIDGE_ERROR')
    })

    it('returns 503 when bridge unconfigured (no env)', async () => {
        delete process.env.PLEXO_GRAPHITI_SIDECAR_URL
        // Service-key still needed for requireServiceKey to pass, but bridge env missing
        setGraphRouterClientForTest(null)
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/episodes`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: VALID_WORKSPACE, content: 'hi' }),
        })
        expect(res.status).toBe(503)
    })

    it('rejects requests without service-key auth', async () => {
        const headers = authHeaders()
        delete headers.Authorization
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/episodes`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ workspaceId: VALID_WORKSPACE, content: 'hi' }),
        })
        expect(res.status).toBe(401)
    })
})

describe('GET /api/v1/graph/facts/search', () => {
    it('proxies to bridge.search and forwards results', async () => {
        const fake = {
            search: vi.fn(async () => ({
                results: [
                    {
                        uuid: 'edge-1', fact: 'X likes Y',
                        source_node_uuid: 'n-1', target_node_uuid: 'n-2',
                        valid_at: '2026-01-01T00:00:00Z', invalid_at: null, created_at: '2026-01-01T00:00:00Z',
                    },
                ],
            })),
        } as unknown as GraphitiClient
        setGraphRouterClientForTest(fake)

        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/facts/search?workspaceId=${VALID_WORKSPACE}&q=likes&limit=5`, {
            method: 'GET',
            headers: authHeaders(),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { results: Array<{ uuid: string; fact: string }> }
        expect(body.results).toHaveLength(1)
        expect(body.results[0]!.fact).toBe('X likes Y')
    })

    it('rejects missing workspaceId (400)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/facts/search?q=hi`, { method: 'GET', headers: authHeaders() })
        expect(res.status).toBe(400)
    })

    it('rejects empty query (400)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/facts/search?workspaceId=${VALID_WORKSPACE}&q=`, { method: 'GET', headers: authHeaders() })
        expect(res.status).toBe(400)
    })

    it('rejects out-of-range limit (400)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/graph/facts/search?workspaceId=${VALID_WORKSPACE}&q=hi&limit=999`, { method: 'GET', headers: authHeaders() })
        expect(res.status).toBe(400)
    })
})
