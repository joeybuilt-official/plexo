// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SDK 1.1.0 graph methods — addEpisode + searchFacts.
 * Tests use a mock fetch impl since PlexoClient relies on global fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PlexoClient } from './client.js'

const WS = '00000000-0000-0000-0000-000000000001'
// ── SDK 1.2.0 — tools.gmessages ──────────────────────────────────────────────

describe('PlexoClient.tools.gmessages.send', () => {
    let originalFetch: typeof fetch
    beforeEach(() => {
        originalFetch = global.fetch
    })
    afterEach(() => {
        global.fetch = originalFetch
    })

    it('POSTs to /api/v1/tools/gmessages/send and maps the response', async () => {
        let captured: { url: string; init?: RequestInit } | null = null
        global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            captured = { url: String(url), init }
            return new Response(
                JSON.stringify({ messageId: 'sidecar-msg-7', deliveryStatus: 'accepted' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
        }) as unknown as typeof fetch

        const client = new PlexoClient({ appId: 'levio', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.tools.gmessages.send({ workspaceId: WS, threadId: 'gt-1', text: 'hello' })

        expect(r).toEqual({ messageId: 'sidecar-msg-7', deliveryStatus: 'accepted' })
        expect(captured!.url).toBe('http://localhost:8080/api/v1/tools/gmessages/send')
        const body = JSON.parse(captured!.init!.body as string)
        expect(body).toEqual({ workspaceId: WS, text: 'hello', threadId: 'gt-1' })
        const headers = captured!.init!.headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer k')
        expect(headers['X-App-Id']).toBe('levio')
        expect(headers['X-Workspace-Id']).toBe(WS)
    })

    it('forwards phoneE164 when supplied', async () => {
        let capturedBody: Record<string, unknown> = {}
        global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            capturedBody = JSON.parse(init!.body as string)
            return new Response(JSON.stringify({ messageId: 'x', deliveryStatus: 'accepted' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'levio', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        await client.tools.gmessages.send({ workspaceId: WS, threadId: 'gt-1', phoneE164: '+15551234567', text: 'hi' })
        expect(capturedBody.phoneE164).toBe('+15551234567')
        expect(capturedBody.threadId).toBe('gt-1')
    })

    it('defaults deliveryStatus to "accepted" when server omits it', async () => {
        global.fetch = vi.fn(async () =>
            new Response(JSON.stringify({ messageId: 'm1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'levio', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.tools.gmessages.send({ workspaceId: WS, threadId: 'gt-1', text: 'hi' })
        expect(r.deliveryStatus).toBe('accepted')
    })

    it('throws PlexoApiError on 404 connection-not-installed (no swallow)', async () => {
        global.fetch = vi.fn(async () =>
            new Response(JSON.stringify({ error: { code: 'CONNECTION_NOT_INSTALLED' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
        ) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'levio', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        await expect(
            client.tools.gmessages.send({ workspaceId: WS, threadId: 'gt-1', text: 'hi' }),
        ).rejects.toThrow()
    })

    it('throws on network error (no swallow)', async () => {
        global.fetch = vi.fn(async () => { throw new Error('econnrefused') }) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'levio', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        await expect(
            client.tools.gmessages.send({ workspaceId: WS, threadId: 'gt-1', text: 'hi' }),
        ).rejects.toThrow()
    })
})

describe('PlexoClient.tools.gmessages.listThreads', () => {
    let originalFetch: typeof fetch
    beforeEach(() => {
        originalFetch = global.fetch
    })
    afterEach(() => {
        global.fetch = originalFetch
    })

    it('GETs /api/v1/tools/gmessages/threads with workspaceId + limit', async () => {
        let capturedUrl = ''
        global.fetch = vi.fn(async (url: string | URL | Request) => {
            capturedUrl = String(url)
            return new Response(
                JSON.stringify({
                    threads: [
                        {
                            threadId: 'gt-1',
                            participants: [],
                            lastMessage: { text: 'hi', direction: 'inbound', sentAt: '2026-05-12T10:00:00Z' },
                            unreadCount: 0,
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
        }) as unknown as typeof fetch

        const client = new PlexoClient({ appId: 'levio', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.tools.gmessages.listThreads({ workspaceId: WS, limit: 50 })

        expect(r).toHaveLength(1)
        expect(r[0]!.threadId).toBe('gt-1')
        expect(r[0]!.lastMessage.direction).toBe('inbound')
        expect(capturedUrl).toContain('/api/v1/tools/gmessages/threads?')
        expect(capturedUrl).toContain(`workspaceId=${encodeURIComponent(WS)}`)
        expect(capturedUrl).toContain('limit=50')
    })

    it('forwards phoneE164 in the query when supplied', async () => {
        let capturedUrl = ''
        global.fetch = vi.fn(async (url: string | URL | Request) => {
            capturedUrl = String(url)
            return new Response(JSON.stringify({ threads: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'levio', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        await client.tools.gmessages.listThreads({ workspaceId: WS, phoneE164: '+15551234567' })
        expect(capturedUrl).toContain(`phoneE164=${encodeURIComponent('+15551234567')}`)
    })

    it('returns [] when the server omits the threads array', async () => {
        global.fetch = vi.fn(async () =>
            new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'levio', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        const r = await client.tools.gmessages.listThreads({ workspaceId: WS })
        expect(r).toEqual([])
    })

    it('throws PlexoApiError on 404 (no swallow)', async () => {
        global.fetch = vi.fn(async () =>
            new Response(JSON.stringify({ error: { code: 'CONNECTION_NOT_INSTALLED' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
        ) as unknown as typeof fetch
        const client = new PlexoClient({ appId: 'levio', plexoUrl: 'http://localhost:8080', serviceKey: 'k' })
        await expect(
            client.tools.gmessages.listThreads({ workspaceId: WS }),
        ).rejects.toThrow()
    })
})
