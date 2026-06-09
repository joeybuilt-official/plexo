// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0001 §1/§3/§5 — PlexoClient.connect() resolution ladder + handshake.
 */
import { describe, it, expect, vi } from 'vitest'
import { PlexoClient } from './client.js'
import { PlexoProtocolError } from './errors.js'
import { PEX_CONTRACT_VERSION } from '../contract.js'

const WS = '00000000-0000-0000-0000-000000000001'

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const body = handler(String(url), init)
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
}

describe('PlexoClient.connect — configured rung + handshake', () => {
    it('compatible + workspaceId → returns granted effective profile', async () => {
        let captured: { url: string; body: unknown } | null = null
        const fetchImpl = mockFetch((url, init) => {
            captured = { url, body: JSON.parse(String(init?.body)) }
            return { serverContractVersion: PEX_CONTRACT_VERSION, compatible: true, status: 'granted', effectiveProfile: { connectors: ['github'], capabilities: [] } }
        })
        const client = new PlexoClient({ appId: 'fylo', plexoUrl: 'http://x', serviceKey: 'k', fetchImpl })
        const session = await client.connect({ workspaceId: WS, requestedProfile: { connectors: ['github'], capabilities: [] } })

        expect(session.via).toBe('configured')
        expect(session.url).toBe('http://x')
        expect(session.status).toBe('granted')
        expect(session.effectiveProfile).toEqual({ connectors: ['github'], capabilities: [] })
        expect(captured!.url).toBe('http://x/api/v1/profiles/connect')
        expect(captured!.body).toMatchObject({ contractVersion: PEX_CONTRACT_VERSION, workspaceId: WS, requestedProfile: { connectors: ['github'], capabilities: [] } })
    })

    it('no workspaceId → unscoped', async () => {
        const fetchImpl = mockFetch(() => ({ serverContractVersion: PEX_CONTRACT_VERSION, compatible: true, status: 'unscoped', effectiveProfile: { connectors: [], capabilities: [] } }))
        const client = new PlexoClient({ appId: 'fylo', plexoUrl: 'http://x', serviceKey: 'k', fetchImpl })
        const session = await client.connect()
        expect(session.status).toBe('unscoped')
        expect(session.serverContractVersion).toBe(PEX_CONTRACT_VERSION)
    })

    it('incompatible server major → throws PlexoProtocolError', async () => {
        const fetchImpl = mockFetch(() => ({ serverContractVersion: '1.0.0', compatible: false, status: 'unscoped', effectiveProfile: { connectors: [], capabilities: [] } }))
        const client = new PlexoClient({ appId: 'fylo', plexoUrl: 'http://x', serviceKey: 'k', fetchImpl })
        await expect(client.connect({ workspaceId: WS })).rejects.toBeInstanceOf(PlexoProtocolError)
    })

    it('client contractVersion override is sent', async () => {
        let body: Record<string, unknown> = {}
        const fetchImpl = mockFetch((_u, init) => {
            body = JSON.parse(String(init?.body))
            return { serverContractVersion: '0.9.0', compatible: true, status: 'unscoped', effectiveProfile: { connectors: [], capabilities: [] } }
        })
        const client = new PlexoClient({ appId: 'fylo', plexoUrl: 'http://x', serviceKey: 'k', contractVersion: '0.7.2', fetchImpl })
        await client.connect()
        expect(body.contractVersion).toBe('0.7.2')
    })
})

describe('PlexoClient.negotiateProfile', () => {
    it('POSTs to /profiles/negotiate and returns status + effective', async () => {
        let captured: { url: string; body: Record<string, unknown> } | null = null
        const fetchImpl = mockFetch((url, init) => {
            captured = { url, body: JSON.parse(String(init?.body)) }
            return { status: 'pending', effectiveProfile: { connectors: [], capabilities: [] } }
        })
        const client = new PlexoClient({ appId: 'fylo', plexoUrl: 'http://x', serviceKey: 'k', fetchImpl })
        const r = await client.negotiateProfile(WS, { connectors: ['slack'], capabilities: ['channel:send'] })
        expect(r.status).toBe('pending')
        expect(captured!.url).toBe('http://x/api/v1/profiles/negotiate')
        expect(captured!.body).toMatchObject({ workspaceId: WS, requestedProfile: { connectors: ['slack'], capabilities: ['channel:send'] } })
    })
})
