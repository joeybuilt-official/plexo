// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
    grantRows: [] as Array<{ allowedConnectors: string[]; capabilities: string[]; status: string }>,
    inserted: [] as unknown[],
    updated: [] as unknown[],
}))

vi.mock('@plexo/db', () => ({
    db: {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => h.grantRows }) }) }),
        insert: () => ({ values: (v: unknown) => ({ onConflictDoNothing: async () => { h.inserted.push(v) } }) }),
        update: () => ({ set: (s: unknown) => ({ where: async () => { h.updated.push(s) } }) }),
    },
    eq: vi.fn(() => ({})),
    and: vi.fn((...a: unknown[]) => ({ __and: a })),
    desc: vi.fn(() => ({})),
    workspaceAppGrants: { allowedConnectors: '', capabilities: '', status: '', workspaceId: '', appId: '' },
}))

import { negotiateProfile, assertInScope, ProfileScopeError, PROFILE_SCOPE_EXCEEDED } from '../profile-negotiation.js'

const WS = '11111111-1111-1111-1111-111111111111'
const APP = 'fylo'

beforeEach(() => {
    h.grantRows = []
    h.inserted = []
    h.updated = []
})

describe('negotiateProfile', () => {
    it('no grant row → pending + captures request, empty effective', async () => {
        const r = await negotiateProfile({ appId: APP, workspaceId: WS, requestedProfile: { connectors: ['github'], capabilities: ['channel:send'] } })
        expect(r.status).toBe('pending')
        expect(r.effectiveProfile).toEqual({ connectors: [], capabilities: [] })
        expect(h.inserted).toHaveLength(1)
        expect(h.inserted[0]).toMatchObject({ appId: APP, workspaceId: WS, status: 'pending', allowedConnectors: ['github'], capabilities: ['channel:send'] })
    })

    it('pending row → refreshes proposal, stays pending, empty effective', async () => {
        h.grantRows = [{ allowedConnectors: ['old'], capabilities: [], status: 'pending' }]
        const r = await negotiateProfile({ appId: APP, workspaceId: WS, requestedProfile: { connectors: ['github'], capabilities: [] } })
        expect(r.status).toBe('pending')
        expect(r.effectiveProfile).toEqual({ connectors: [], capabilities: [] })
        expect(h.updated).toHaveLength(1)
        expect(h.updated[0]).toMatchObject({ allowedConnectors: ['github'] })
    })

    it('granted row → effective = intersection(requested, granted)', async () => {
        h.grantRows = [{ allowedConnectors: ['github', 'slack'], capabilities: ['memory:read:note'], status: 'granted' }]
        const r = await negotiateProfile({ appId: APP, workspaceId: WS, requestedProfile: { connectors: ['github'], capabilities: ['memory:read:note', 'channel:send'] } })
        expect(r.status).toBe('granted')
        expect(r.effectiveProfile).toEqual({ connectors: ['github'], capabilities: ['memory:read:note'] })
    })

    it('granted row + no request → full grant', async () => {
        h.grantRows = [{ allowedConnectors: ['github'], capabilities: [], status: 'granted' }]
        const r = await negotiateProfile({ appId: APP, workspaceId: WS })
        expect(r.status).toBe('granted')
        expect(r.effectiveProfile).toEqual({ connectors: ['github'], capabilities: [] })
    })

    it('revoked row → revoked, empty effective', async () => {
        h.grantRows = [{ allowedConnectors: ['github'], capabilities: [], status: 'revoked' }]
        const r = await negotiateProfile({ appId: APP, workspaceId: WS, requestedProfile: { connectors: ['github'], capabilities: [] } })
        expect(r.status).toBe('revoked')
        expect(r.effectiveProfile).toEqual({ connectors: [], capabilities: [] })
    })
})

describe('assertInScope / ProfileScopeError', () => {
    const profile = { connectors: ['github'], capabilities: ['memory:read:*'] }

    it('passes for in-scope connector + capability', () => {
        expect(() => assertInScope(profile, { connector: 'github' })).not.toThrow()
        expect(() => assertInScope(profile, { capability: 'memory:read:person' })).not.toThrow()
    })

    it('throws PROFILE_SCOPE_EXCEEDED for out-of-scope connector', () => {
        try {
            assertInScope(profile, { connector: 'slack' })
            expect.unreachable('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(ProfileScopeError)
            expect((e as ProfileScopeError).code).toBe(PROFILE_SCOPE_EXCEEDED)
            expect((e as ProfileScopeError).status).toBe(403)
        }
    })

    it('throws for out-of-scope capability', () => {
        expect(() => assertInScope(profile, { capability: 'memory:write:note' })).toThrow(ProfileScopeError)
    })
})
