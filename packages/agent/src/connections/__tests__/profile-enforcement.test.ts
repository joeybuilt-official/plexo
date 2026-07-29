// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0001 §3 — loadConnectionTools profile enforcement.
 * Proves a connection whose registry ID is not in the app's granted profile is
 * excluded from the tool set (not merely hidden) when enforcement is on, and is
 * loaded normally when enforcement is off / no appId.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
    connRows: [] as Array<Record<string, unknown>>,
    grantRows: [] as Array<{ allowedConnectors: string[]; capabilities: string[]; status: string }>,
}))

vi.mock('@plexo/db', () => {
    const chainFor = (t: { _t: string }) => {
        switch (t._t) {
            case 'ws':    return { where: () => ({ limit: async () => [{ settings: {} }] }) }
            case 'grant': return { where: () => ({ limit: async () => hoisted.grantRows }) }
            case 'conn':  return { where: () => Promise.resolve(hoisted.connRows) }
            default:      return { where: () => Promise.resolve([]) }  // ext dedup
        }
    }
    return {
        db: { select: () => ({ from: (t: { _t: string }) => chainFor(t) }) },
        eq: vi.fn(() => ({})),
        and: vi.fn((...a: unknown[]) => ({ __and: a })),
        inArray: vi.fn(() => ({})),
        installedConnections: { _t: 'conn' },
        workspaces: { _t: 'ws' },
        extensions: { _t: 'ext' },
        workspaceAppGrants: { _t: 'grant' },
    }
})

import { loadConnectionTools } from '../bridge.js'

const WS = 'ws-1'
const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
    hoisted.connRows = [
        { id: 'c1', registryId: 'github', credentials: null, enabledTools: null, status: 'active' },
        { id: 'c2', registryId: 'slack', credentials: null, enabledTools: null, status: 'active' },
    ]
    hoisted.grantRows = []
    delete process.env.PROFILE_ENFORCEMENT_ENABLED
    delete process.env.PROFILE_ENFORCEMENT_MODE
})

afterEach(() => { process.env = { ...ORIGINAL_ENV } })

describe('loadConnectionTools — profile enforcement', () => {
    it('no enforcement (flag off) → both connections load', async () => {
        const tools = await loadConnectionTools(WS, undefined, 'fylo')
        const keys = Object.keys(tools)
        expect(keys.some(k => k.startsWith('github__'))).toBe(true)
        expect(keys.some(k => k.startsWith('slack__'))).toBe(true)
    })

    it('enforcing, grant allows only github → slack excluded', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        hoisted.grantRows = [{ allowedConnectors: ['github'], capabilities: [], status: 'granted' }]
        const tools = await loadConnectionTools(WS, undefined, 'fylo')
        const keys = Object.keys(tools)
        expect(keys.some(k => k.startsWith('github__'))).toBe(true)
        expect(keys.some(k => k.startsWith('slack__'))).toBe(false)
    })

    it('enforcing, no grant → all connectors excluded (deny-all)', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        hoisted.grantRows = []
        const tools = await loadConnectionTools(WS, undefined, 'fylo')
        const keys = Object.keys(tools)
        expect(keys.some(k => k.startsWith('github__'))).toBe(false)
        expect(keys.some(k => k.startsWith('slack__'))).toBe(false)
    })

    it('monitor mode, no grant → nothing excluded (would-deny logged, both load)', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        process.env.PROFILE_ENFORCEMENT_MODE = 'monitor'
        hoisted.grantRows = []
        const tools = await loadConnectionTools(WS, undefined, 'fylo')
        const keys = Object.keys(tools)
        expect(keys.some(k => k.startsWith('github__'))).toBe(true)
        expect(keys.some(k => k.startsWith('slack__'))).toBe(true)
    })

    it('enforcing but no appId → no enforcement (both load)', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        hoisted.grantRows = []
        const tools = await loadConnectionTools(WS, undefined, undefined)
        const keys = Object.keys(tools)
        expect(keys.some(k => k.startsWith('github__'))).toBe(true)
        expect(keys.some(k => k.startsWith('slack__'))).toBe(true)
    })
})
