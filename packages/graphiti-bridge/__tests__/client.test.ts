// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi } from 'vitest'
import { GraphitiClient } from '../src/index.js'

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    return vi.fn(handler) as unknown as typeof fetch
}

describe('GraphitiClient', () => {
    it('health() returns parsed body on 200', async () => {
        const fetchImpl = fakeFetch(async () =>
            new Response(JSON.stringify({ ok: true, service: 'plexo-graphiti', kuzu_data_dir: '/data', hmac_configured: true, phase: '2-scaffold' }), { status: 200 }),
        )
        const c = new GraphitiClient({ baseUrl: 'http://localhost:8080', serviceKey: 'k', fetchImpl })
        const r = await c.health()
        expect(r?.ok).toBe(true)
        expect(r?.service).toBe('plexo-graphiti')
    })

    it('health() returns null on non-2xx', async () => {
        const fetchImpl = fakeFetch(async () => new Response('', { status: 503 }))
        const c = new GraphitiClient({ baseUrl: 'http://localhost:8080', serviceKey: 'k', fetchImpl })
        expect(await c.health()).toBeNull()
    })

    it('addEpisode() signs the request body with sha256-HMAC and an ISO timestamp', async () => {
        let capturedHeaders: Record<string, string> = {}
        let capturedBody = ''
        const fetchImpl = fakeFetch(async (_url, init) => {
            capturedHeaders = init?.headers as Record<string, string>
            capturedBody = init?.body as string
            return new Response(JSON.stringify({ episodeId: 'ep-1' }), { status: 200 })
        })
        const c = new GraphitiClient({ baseUrl: 'http://localhost:8080', serviceKey: 'shared-key', fetchImpl })
        await c.addEpisode({ workspaceId: 'ws-1', content: 'hello' })

        expect(capturedHeaders['X-App-Id']).toBe('plexo-api')
        expect(capturedHeaders['X-Plexo-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
        expect(capturedHeaders['X-Plexo-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/)

        const parsed = JSON.parse(capturedBody)
        expect(parsed.workspace_id).toBe('ws-1')
        expect(parsed.content).toBe('hello')
        expect(parsed.episode_type).toBe('message')
    })

    it('postSigned() returns null on network error', async () => {
        const fetchImpl = fakeFetch(async () => { throw new Error('econnrefused') })
        const c = new GraphitiClient({ baseUrl: 'http://localhost:8080', serviceKey: 'k', fetchImpl })
        expect(await c.search({ workspaceId: 'ws-1', query: 'x' })).toBeNull()
    })
})
