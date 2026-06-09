// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mutable grant row(s) the mocked DB returns for the workspace_app_grants query.
let grantRows: Array<{ allowedConnectors: string[]; capabilities: string[]; status: string }> = []

vi.mock('@plexo/db', () => {
    const limit = vi.fn(async () => grantRows)
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    return {
        db: { select },
        eq: vi.fn(() => ({})),
        and: vi.fn((...a: unknown[]) => ({ __and: a })),
        workspaceAppGrants: {
            allowedConnectors: 'allowed_connectors',
            capabilities: 'capabilities',
            status: 'status',
            workspaceId: 'workspace_id',
            appId: 'app_id',
        },
    }
})

import { resolveEnforcedProfile, loadGrantedProfile, getEnforcementMode } from '../grant.js'

const WS = 'ws-1'
const APP = 'fylo'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
    grantRows = []
    delete process.env.PROFILE_ENFORCEMENT_ENABLED
    delete process.env.PROFILE_ENFORCEMENT_MODE
    delete process.env.PLEXO_DEV_AUTOGRANT
    delete process.env.NODE_ENV
})

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
})

describe('resolveEnforcedProfile — enforcement gate', () => {
    it('returns null when no appId (interactive/cron task)', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        expect(await resolveEnforcedProfile(WS, undefined)).toBeNull()
    })

    it('returns null when enforcement flag is off (default)', async () => {
        grantRows = [{ allowedConnectors: ['github'], capabilities: [], status: 'granted' }]
        expect(await resolveEnforcedProfile(WS, APP)).toBeNull()
    })

    it('returns null under dev autogrant (non-prod)', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        process.env.PLEXO_DEV_AUTOGRANT = '1'
        process.env.NODE_ENV = 'development'
        expect(await resolveEnforcedProfile(WS, APP)).toBeNull()
    })

    it('dev autogrant is NOT honored in production', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        process.env.PLEXO_DEV_AUTOGRANT = '1'
        process.env.NODE_ENV = 'production'
        grantRows = [{ allowedConnectors: ['github'], capabilities: [], status: 'granted' }]
        expect(await resolveEnforcedProfile(WS, APP)).toEqual({ connectors: ['github'], capabilities: [] })
    })

    it('enforcing + granted row → effective profile = grant', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        grantRows = [{ allowedConnectors: ['github', 'slack'], capabilities: ['memory:read:note'], status: 'granted' }]
        expect(await resolveEnforcedProfile(WS, APP)).toEqual({
            connectors: ['github', 'slack'],
            capabilities: ['memory:read:note'],
        })
    })

    it('enforcing + no grant row → deny-all (EMPTY profile)', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        grantRows = []
        expect(await resolveEnforcedProfile(WS, APP)).toEqual({ connectors: [], capabilities: [] })
    })

    it('enforcing + revoked grant → deny-all', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        grantRows = [{ allowedConnectors: ['github'], capabilities: [], status: 'revoked' }]
        expect(await resolveEnforcedProfile(WS, APP)).toEqual({ connectors: [], capabilities: [] })
    })

    it('enforcing + pending grant → deny-all (not yet approved)', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        grantRows = [{ allowedConnectors: ['github'], capabilities: [], status: 'pending' }]
        expect(await resolveEnforcedProfile(WS, APP)).toEqual({ connectors: [], capabilities: [] })
    })
})

describe('getEnforcementMode — rollout states', () => {
    it("'off' when the flag is unset (default)", () => {
        expect(getEnforcementMode()).toBe('off')
    })

    it("'off' under dev autogrant", () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        process.env.PLEXO_DEV_AUTOGRANT = '1'
        process.env.NODE_ENV = 'development'
        expect(getEnforcementMode()).toBe('off')
    })

    it("'enforce' when the flag is on with no mode set", () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        expect(getEnforcementMode()).toBe('enforce')
    })

    it("'monitor' when the flag is on and mode=monitor", () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        process.env.PROFILE_ENFORCEMENT_MODE = 'monitor'
        expect(getEnforcementMode()).toBe('monitor')
    })

    it("'enforce' for any non-monitor mode value", () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        process.env.PROFILE_ENFORCEMENT_MODE = 'enforce'
        expect(getEnforcementMode()).toBe('enforce')
    })

    it('monitor still resolves the real profile (so bridges can compute would-exclude)', async () => {
        process.env.PROFILE_ENFORCEMENT_ENABLED = 'true'
        process.env.PROFILE_ENFORCEMENT_MODE = 'monitor'
        grantRows = []
        // No grant → deny-all profile is still computed; the bridge decides not to
        // enforce it in monitor mode.
        expect(await resolveEnforcedProfile(WS, APP)).toEqual({ connectors: [], capabilities: [] })
    })
})

describe('loadGrantedProfile', () => {
    it('returns null for non-granted status', async () => {
        grantRows = [{ allowedConnectors: ['github'], capabilities: [], status: 'pending' }]
        expect(await loadGrantedProfile(WS, APP)).toBeNull()
    })

    it('returns the profile for a granted row', async () => {
        grantRows = [{ allowedConnectors: ['github'], capabilities: ['channel:send'], status: 'granted' }]
        expect(await loadGrantedProfile(WS, APP)).toEqual({ connectors: ['github'], capabilities: ['channel:send'] })
    })
})
