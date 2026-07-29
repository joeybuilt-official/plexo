// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach } from 'vitest'
import { applyCrossAppFilter } from '../cross-app-filter.js'
import { setPolicySignalEmitter, type PolicySignal } from '../signals.js'
import type { PolicyEdge } from '../types.js'

const WS = '00000000-0000-0000-0000-000000000001'

function edge(callerApp: string | null, fact = 'X likes Y'): PolicyEdge {
    return {
        uuid: `e-${callerApp ?? 'null'}`,
        fact,
        callerApp,
        plexoUserId: null,
        valid_at: null,
        invalid_at: null,
        created_at: null,
    }
}

describe('applyCrossAppFilter', () => {
    let signals: PolicySignal[]
    beforeEach(() => {
        signals = []
        setPolicySignalEmitter((s) => signals.push(s))
    })

    it('allows edges from the caller’s own app', () => {
        const r = applyCrossAppFilter([edge('plexo')], { workspaceId: WS, appId: 'plexo', allowedApps: new Set() })
        expect(r.allowed).toHaveLength(1)
        expect(r.denied).toHaveLength(0)
    })

    it('allows un-attributed (null callerApp) edges — pre-Phase-5 corpus rows', () => {
        const r = applyCrossAppFilter([edge(null)], { workspaceId: WS, appId: 'plexo', allowedApps: new Set() })
        expect(r.allowed).toHaveLength(1)
        expect(r.denied).toHaveLength(0)
    })

    it('DENIES cross-app edges by default (empty allowedApps)', () => {
        const r = applyCrossAppFilter([edge('levio')], { workspaceId: WS, appId: 'plexo', allowedApps: new Set() })
        expect(r.allowed).toHaveLength(0)
        expect(r.denied).toHaveLength(1)
        expect(signals.some((s) => s.kind === 'cross_app_deny')).toBe(true)
    })

    it('allows cross-app edges when allowedApps contains the foreign app', () => {
        const r = applyCrossAppFilter([edge('levio')], { workspaceId: WS, appId: 'plexo', allowedApps: new Set(['levio']) })
        expect(r.allowed).toHaveLength(1)
        expect(r.denied).toHaveLength(0)
        expect(signals).toHaveLength(0)
    })

    it('partitions a mixed batch and emits exactly one deny signal w/ count=2', () => {
        const r = applyCrossAppFilter(
            [edge('plexo'), edge('levio'), edge('fonto'), edge(null), edge('plexo')],
            { workspaceId: WS, appId: 'plexo', allowedApps: new Set() },
        )
        expect(r.allowed).toHaveLength(3)
        expect(r.denied).toHaveLength(2)
        expect(signals).toHaveLength(1)
        expect(signals[0]!.count).toBe(2)
    })

    it('skips signal emission when nothing is denied', () => {
        applyCrossAppFilter([edge('plexo'), edge(null)], { workspaceId: WS, appId: 'plexo', allowedApps: new Set() })
        expect(signals).toHaveLength(0)
    })
})
