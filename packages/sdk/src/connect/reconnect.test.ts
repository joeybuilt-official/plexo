// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0001 §1 + Phase 4e — long-lived connection reconnect/re-registration.
 *
 * Pins:
 *   1. autoReconnect ON + connect() session → a transport failure triggers one
 *      reconnect (re-handshake + register) and a single retry that succeeds.
 *   2. autoReconnect OFF (default) → no reconnect; the error propagates.
 *   3. autoReconnect ON but no connect() session → no reconnect.
 *   4. reconnect() re-runs the handshake AND register(), refreshing the session.
 */
import { describe, it, expect, vi } from 'vitest'
import { PlexoClient } from './client.js'
import { PlexoUnreachableError } from './errors.js'
import { PEX_CONTRACT_VERSION } from '../contract.js'

const WS = '00000000-0000-0000-0000-000000000001'

function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function connectBody(extra: Record<string, unknown> = {}) {
    return { serverContractVersion: PEX_CONTRACT_VERSION, status: 'unscoped', effectiveProfile: { connectors: [], capabilities: [] }, ...extra }
}

describe('PlexoClient reconnect (Phase 4e)', () => {
    it('autoReconnect ON: transient failure → reconnect + retry succeeds', async () => {
        let dataCalls = 0, connectCalls = 0, registerCalls = 0
        const fetchImpl = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
            const url = String(u)
            if (url.endsWith('/api/v1/profiles/connect')) { connectCalls++; return jsonRes(connectBody()) }
            if (url.endsWith('/api/v1/profiles/register')) { registerCalls++; return jsonRes({ ok: true }) }
            if (url.includes('/api/v1/connections/installed')) {
                dataCalls++
                if (dataCalls === 1) throw new TypeError('network down')
                return jsonRes({ items: [{ id: 'c1' }] })
            }
            return jsonRes({})
        }) as unknown as typeof fetch

        const client = new PlexoClient({ appId: 'fylo', plexoUrl: 'http://x', serviceKey: 'k', autoReconnect: true, fetchImpl })
        await client.connect({ workspaceId: WS })
        const conns = await client.getInstalledConnections(WS)

        expect(conns).toEqual([{ id: 'c1' }])
        expect(dataCalls).toBe(2)     // failed once, retried once
        expect(connectCalls).toBe(2)  // initial connect + reconnect handshake
        expect(registerCalls).toBe(1) // reconnect re-registered the toolset
    })

    it('autoReconnect OFF (default): error propagates, no reconnect', async () => {
        let connectCalls = 0
        const fetchImpl = vi.fn(async (u: string | URL | Request) => {
            const url = String(u)
            if (url.endsWith('/api/v1/profiles/connect')) { connectCalls++; return jsonRes(connectBody()) }
            if (url.endsWith('/api/v1/ai/complete')) throw new TypeError('down')
            return jsonRes({})
        }) as unknown as typeof fetch

        const client = new PlexoClient({ appId: 'fylo', plexoUrl: 'http://x', serviceKey: 'k', fetchImpl })
        await client.connect()
        await expect(client.aiComplete(WS, { messages: [{ role: 'user', content: 'hi' }] }))
            .rejects.toBeInstanceOf(PlexoUnreachableError)
        expect(connectCalls).toBe(1) // never reconnected
    })

    it('autoReconnect ON but no connect() session: error propagates', async () => {
        const fetchImpl = vi.fn(async (u: string | URL | Request) => {
            const url = String(u)
            if (url.endsWith('/api/v1/ai/complete')) throw new TypeError('down')
            return jsonRes({})
        }) as unknown as typeof fetch

        const client = new PlexoClient({ appId: 'fylo', plexoUrl: 'http://x', serviceKey: 'k', autoReconnect: true, fetchImpl })
        await expect(client.aiComplete(WS, { messages: [{ role: 'user', content: 'hi' }] }))
            .rejects.toBeInstanceOf(PlexoUnreachableError)
    })

    it('reconnect() re-handshakes + re-registers and refreshes the session', async () => {
        let connectCalls = 0, registerCalls = 0
        const fetchImpl = vi.fn(async (u: string | URL | Request) => {
            const url = String(u)
            if (url.endsWith('/api/v1/profiles/connect')) { connectCalls++; return jsonRes(connectBody({ status: 'granted', effectiveProfile: { connectors: ['github'], capabilities: [] } })) }
            if (url.endsWith('/api/v1/profiles/register')) { registerCalls++; return jsonRes({ ok: true }) }
            return jsonRes({})
        }) as unknown as typeof fetch

        const client = new PlexoClient({ appId: 'fylo', plexoUrl: 'http://x', serviceKey: 'k', fetchImpl })
        await client.connect({ workspaceId: WS })
        const s = await client.reconnect()

        expect(connectCalls).toBe(2)
        expect(registerCalls).toBe(1)
        expect(s.status).toBe('granted')
        expect(s.effectiveProfile).toEqual({ connectors: ['github'], capabilities: [] })
    })
})
