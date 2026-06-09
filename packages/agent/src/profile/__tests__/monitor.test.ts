// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0001 §3 — recordMonitorObservations upsert helper.
 * Pins: dedups within a batch (ON CONFLICT can't touch a row twice), and never
 * throws (best-effort — must not break tool-load).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ inserted: [] as unknown[], throwOnInsert: false }))

vi.mock('@plexo/db', () => {
    const onConflictDoUpdate = vi.fn(async () => { if (hoisted.throwOnInsert) throw new Error('db down') })
    const values = vi.fn((rows: unknown[]) => { hoisted.inserted = rows; return { onConflictDoUpdate } })
    const insert = vi.fn(() => ({ values }))
    return {
        db: { insert },
        sql: (s: unknown) => s,
        profileMonitorObservations: {
            workspaceId: 'workspace_id', appId: 'app_id', kind: 'kind', token: 'token', observedCount: 'observed_count',
        },
    }
})

import { recordMonitorObservations } from '../monitor.js'

const WS = 'ws-1'
const APP = 'levio'

beforeEach(() => { hoisted.inserted = []; hoisted.throwOnInsert = false })

describe('recordMonitorObservations', () => {
    it('no-ops on empty input (no insert)', async () => {
        await recordMonitorObservations(WS, APP, [])
        expect(hoisted.inserted).toEqual([])
    })

    it('dedups duplicate (kind,token) within the batch', async () => {
        await recordMonitorObservations(WS, APP, [
            { kind: 'connector', token: 'github' },
            { kind: 'connector', token: 'github' },
            { kind: 'capability', token: 'storage:read', extName: '@x/y' },
        ])
        expect(hoisted.inserted).toHaveLength(2)
        expect(hoisted.inserted).toEqual([
            { workspaceId: WS, appId: APP, kind: 'connector', token: 'github', extName: null },
            { workspaceId: WS, appId: APP, kind: 'capability', token: 'storage:read', extName: '@x/y' },
        ])
    })

    it('swallows DB errors (best-effort, never throws)', async () => {
        hoisted.throwOnInsert = true
        await expect(recordMonitorObservations(WS, APP, [{ kind: 'connector', token: 'slack' }]))
            .resolves.toBeUndefined()
    })
})
