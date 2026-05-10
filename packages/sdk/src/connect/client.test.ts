// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SDK 1.1.0 graph methods — addEpisode + searchFacts.
 * Tests use a mock fetch impl since PlexoClient relies on global fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PlexoClient } from './client.js'

const WS = '00000000-0000-0000-0000-000000000001'

describe('PlexoClient.addEpisode', () => {
    let originalFetch: typeof fetch
    beforeEach(() => {
        originalFetch = global.fetch
    })
    afterEach(() => {
        global.fetch = originalFetch
    })

    it('POSTs to /api/v1/graph/episodes and returns the typed result', async () => {
        let captured: { url: string; init?: RequestInit } | null = null
        global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            captured = { url: String(url), init }
            return new Response(
                JSON.stringify({ episodeId: 'ep-1', extractedFactsCount: 2, extractedNodesCount: 3 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
        }) as unknown as typeof fetch

        const client = new PlexoClient({ appId: 'test', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.addEpisode(WS, { content: 'hello plexo', name: 'test', metadata: { foo: 'bar' } })

        expect(r).toEqual({ episodeId: 'ep-1', extractedFactsCount: 2, extractedNodesCount: 3 })
        expect(captured!.url).toBe('http://localhost:8080/api/v1/graph/episodes')
        const body = JSON.parse(captured!.init!.body as string)
        expect(body.workspaceId).toBe(WS)
        expect(body.content).toBe('hello plexo')
        expect(body.name).toBe('test')
        expect(body.metadata).toEqual({ foo: 'bar' })
    })

    it('returns null on HTTP error (best-effort SDK contract)', async () => {
        global.fetch = vi.fn(async () => new Response('', { status: 502 })) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'test', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.addEpisode(WS, { content: 'x' })
        expect(r).toBeNull()
    })

    it('returns null on network error', async () => {
        global.fetch = vi.fn(async () => { throw new Error('econnrefused') }) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'test', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.addEpisode(WS, { content: 'x' })
        expect(r).toBeNull()
    })
})

describe('PlexoClient.searchFacts', () => {
    let originalFetch: typeof fetch
    beforeEach(() => {
        originalFetch = global.fetch
    })
    afterEach(() => {
        global.fetch = originalFetch
    })

    it('GETs /api/v1/graph/facts/search and snake→camel-cases the response', async () => {
        let capturedUrl = ''
        global.fetch = vi.fn(async (url: string | URL | Request) => {
            capturedUrl = String(url)
            return new Response(
                JSON.stringify({
                    results: [
                        {
                            uuid: 'edge-1', fact: 'X likes Y',
                            source_node_uuid: 'n-1', target_node_uuid: 'n-2',
                            valid_at: '2026-01-01T00:00:00Z', invalid_at: null, created_at: '2026-01-01T00:00:00Z',
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
        }) as unknown as typeof fetch

        const client = new PlexoClient({ appId: 'test', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.searchFacts(WS, 'likes', 5)

        expect(r).toHaveLength(1)
        expect(r[0]).toEqual({
            uuid: 'edge-1',
            fact: 'X likes Y',
            sourceNodeUuid: 'n-1',
            targetNodeUuid: 'n-2',
            validAt: '2026-01-01T00:00:00Z',
            invalidAt: null,
            createdAt: '2026-01-01T00:00:00Z',
        })
        expect(capturedUrl).toContain('/api/v1/graph/facts/search?')
        expect(capturedUrl).toContain(`workspaceId=${encodeURIComponent(WS)}`)
        expect(capturedUrl).toContain('q=likes')
        expect(capturedUrl).toContain('limit=5')
    })

    it('returns [] on HTTP error', async () => {
        global.fetch = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'test', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.searchFacts(WS, 'x')
        expect(r).toEqual([])
    })

    it('returns [] when results array is missing in the response', async () => {
        global.fetch = vi.fn(async () =>
            new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'test', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.searchFacts(WS, 'x')
        expect(r).toEqual([])
    })
})
