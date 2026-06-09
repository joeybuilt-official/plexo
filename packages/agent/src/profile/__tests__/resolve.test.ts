// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import {
    resolveEffectiveProfile,
    isConnectorAllowed,
    isCapabilityAllowed,
    EMPTY_PROFILE,
    type Profile,
} from '../resolve.js'

describe('resolveEffectiveProfile', () => {
    it('default-deny: no grant → empty profile', () => {
        expect(resolveEffectiveProfile(null, { connectors: ['github'], capabilities: ['memory:read:note'] }))
            .toEqual({ connectors: [], capabilities: [] })
        expect(resolveEffectiveProfile(undefined)).toEqual({ connectors: [], capabilities: [] })
    })

    it('no request → full grant (app did not narrow scope)', () => {
        const granted: Profile = { connectors: ['github', 'slack'], capabilities: ['memory:read:note'] }
        expect(resolveEffectiveProfile(granted)).toEqual(granted)
    })

    it('intersection drops requested-but-not-granted', () => {
        const granted: Profile = { connectors: ['github'], capabilities: ['memory:read:note'] }
        const requested: Profile = { connectors: ['github', 'stripe'], capabilities: ['memory:read:note', 'channel:send'] }
        expect(resolveEffectiveProfile(granted, requested)).toEqual({
            connectors: ['github'],
            capabilities: ['memory:read:note'],
        })
    })

    it('intersection drops granted-but-not-requested (least privilege for session)', () => {
        const granted: Profile = { connectors: ['github', 'slack'], capabilities: ['memory:read:note', 'channel:send'] }
        const requested: Profile = { connectors: ['github'], capabilities: ['channel:send'] }
        expect(resolveEffectiveProfile(granted, requested)).toEqual({
            connectors: ['github'],
            capabilities: ['channel:send'],
        })
    })

    it('empty request → empty effective (app asked for nothing)', () => {
        const granted: Profile = { connectors: ['github'], capabilities: ['memory:read:note'] }
        expect(resolveEffectiveProfile(granted, { connectors: [], capabilities: [] }))
            .toEqual({ connectors: [], capabilities: [] })
    })

    it('prefix wildcard grant matches requested scoped token', () => {
        const granted: Profile = { connectors: [], capabilities: ['memory:read:*'] }
        const requested: Profile = { connectors: [], capabilities: ['memory:read:person', 'memory:write:note'] }
        expect(resolveEffectiveProfile(granted, requested).capabilities).toEqual(['memory:read:person'])
    })

    it('owner wildcard "*" grant matches anything requested', () => {
        const granted: Profile = { connectors: ['*'], capabilities: ['*'] }
        const requested: Profile = { connectors: ['github', 'stripe'], capabilities: ['channel:send'] }
        expect(resolveEffectiveProfile(granted, requested)).toEqual({
            connectors: ['github', 'stripe'],
            capabilities: ['channel:send'],
        })
    })

    it('dedups duplicate requested tokens', () => {
        const granted: Profile = { connectors: ['github'], capabilities: [] }
        const requested: Profile = { connectors: ['github', 'github'], capabilities: [] }
        expect(resolveEffectiveProfile(granted, requested).connectors).toEqual(['github'])
    })
})

describe('isConnectorAllowed / isCapabilityAllowed', () => {
    it('exact connector match', () => {
        const p: Profile = { connectors: ['github'], capabilities: [] }
        expect(isConnectorAllowed(p, 'github')).toBe(true)
        expect(isConnectorAllowed(p, 'slack')).toBe(false)
    })

    it('EMPTY_PROFILE denies everything', () => {
        expect(isConnectorAllowed(EMPTY_PROFILE, 'github')).toBe(false)
        expect(isCapabilityAllowed(EMPTY_PROFILE, 'memory:read:note')).toBe(false)
    })

    it('capability prefix wildcard', () => {
        const p: Profile = { connectors: [], capabilities: ['memory:read:*'] }
        expect(isCapabilityAllowed(p, 'memory:read:person')).toBe(true)
        expect(isCapabilityAllowed(p, 'memory:write:person')).toBe(false)
    })

    it('owner wildcard allows any capability/connector', () => {
        const p: Profile = { connectors: ['*'], capabilities: ['*'] }
        expect(isConnectorAllowed(p, 'anything')).toBe(true)
        expect(isCapabilityAllowed(p, 'whatever:token')).toBe(true)
    })
})
