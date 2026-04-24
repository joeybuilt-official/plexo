// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3b — drift warning inbox tests.
 *
 * Mounts the scl router and exercises the new /drift-warnings inbox
 * endpoints with all DB + scl-core + storage mocks in place.
 *
 * Pins:
 *   1. GET /drift-warnings filters by status + returns counts
 *   2. POST /approve transitions pending → confirmed
 *   3. POST /reject transitions pending → rejected
 *   4. Approve refuses already-resolved warnings
 *   5. Workspace mismatch returns 403
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    rows: [] as any[],
    countRows: [] as any[],
    selectRow: null as any,
    updateCalls: 0,
    executedSql: [] as any[],
}

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => ctl.selectRow ? [ctl.selectRow] : []),
    }
    return {
        db: {
            select: vi.fn(() => builder),
            execute: vi.fn(async (q: any) => {
                ctl.executedSql.push(q)
                const rendered = (q?.strings ?? []).join(' ')
                if (rendered.includes('GROUP BY status')) return { rows: ctl.countRows }
                if (rendered.includes('FROM scl_drift_warnings')) return { rows: ctl.rows }
                return { rows: [] }
            }),
            update: vi.fn(() => ({
                set: vi.fn(() => ({
                    where: vi.fn(async () => { ctl.updateCalls += 1 }),
                })),
            })),
        },
        sclDriftWarnings: { id: 'id', workspaceId: 'workspace_id' },
        workspaces: { id: 'id', settings: 'settings', intelligenceSettings: 'intelligence_settings' },
        eq: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../lib/intelligence-cache.js', () => ({
    invalidateIntelligenceSettings: vi.fn(),
}))

vi.mock('@plexo/agent/scl/storage', () => ({
    invalidateSclRuntimeSettings: vi.fn(),
    loadGoldenRecord: vi.fn(async () => ({
        id: 'gr-1',
        version: 'scl/1.0',
        workspaceId: 'ws-1',
        regions: [],
        attractors: [],
        transformations: [],
        ledgerRefs: [],
        bootedAt: 0,
        lastMutatedAt: 0,
    })),
    saveGoldenRecord: vi.fn(async () => undefined),
}))

vi.mock('@plexo/scl-core', () => ({
    resolveDrift: vi.fn((record: any) => record),
}))

let server: Server | null = null
let baseUrl: string

beforeEach(async () => {
    ctl.rows = []
    ctl.countRows = []
    ctl.selectRow = null
    ctl.updateCalls = 0
    ctl.executedSql = []
    if (!server) {
        const { sclRouter } = await import('../scl.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/scl', sclRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

const WS = 'ws-1'

describe('GET /api/v1/scl/drift-warnings', () => {
    it('returns rows + per-status counts', async () => {
        ctl.rows = [
            { id: 'd1', attractor_id: 'a1', attractor_label: 'plan', semantic_distance: 0.21, threshold: 0.15, source: 'extractor', status: 'pending', created_at: new Date().toISOString(), resolved_at: null },
            { id: 'd2', attractor_id: 'a2', attractor_label: 'verify', semantic_distance: 0.18, threshold: 0.15, source: 'extractor', status: 'pending', created_at: new Date().toISOString(), resolved_at: null },
        ]
        ctl.countRows = [
            { status: 'pending', count: 2 },
            { status: 'confirmed', count: 5 },
            { status: 'rejected', count: 1 },
        ]
        const res = await fetch(`${baseUrl}/api/v1/scl/drift-warnings?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.warnings).toHaveLength(2)
        expect(body.warnings[0].attractorLabel).toBe('plan')
        expect(body.counts).toEqual({ pending: 2, confirmed: 5, rejected: 1 })
    })

    it('rejects unknown status filter', async () => {
        const res = await fetch(`${baseUrl}/api/v1/scl/drift-warnings?workspaceId=${WS}&status=garbage`)
        expect(res.status).toBe(400)
    })
})

describe('POST /api/v1/scl/drift-warnings/:id/approve', () => {
    it('transitions pending → confirmed', async () => {
        ctl.selectRow = {
            id: 'd1',
            workspaceId: WS,
            attractorId: 'a1',
            attractorLabel: 'plan',
            currentPosition: [0.1, 0.2],
            proposedPosition: [0.3, 0.4],
            semanticDistance: 0.21,
            threshold: 0.15,
            source: 'extractor',
            status: 'pending',
            createdAt: new Date(),
        }
        const res = await fetch(`${baseUrl}/api/v1/scl/drift-warnings/d1/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.status).toBe('confirmed')
        expect(ctl.updateCalls).toBe(1)
    })

    it('returns 400 when warning is already resolved', async () => {
        ctl.selectRow = {
            id: 'd1',
            workspaceId: WS,
            status: 'confirmed',
            attractorId: 'a1',
            attractorLabel: 'plan',
            currentPosition: [],
            proposedPosition: [],
            semanticDistance: 0,
            threshold: 0,
            source: 's',
            createdAt: new Date(),
        }
        const res = await fetch(`${baseUrl}/api/v1/scl/drift-warnings/d1/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
    })

    it('returns 403 on workspace mismatch', async () => {
        ctl.selectRow = {
            id: 'd1',
            workspaceId: 'other-ws',
            status: 'pending',
            attractorId: 'a1',
            attractorLabel: 'plan',
            currentPosition: [],
            proposedPosition: [],
            semanticDistance: 0,
            threshold: 0,
            source: 's',
            createdAt: new Date(),
        }
        const res = await fetch(`${baseUrl}/api/v1/scl/drift-warnings/d1/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(403)
    })
})

describe('POST /api/v1/scl/drift-warnings/:id/reject', () => {
    it('transitions pending → rejected', async () => {
        ctl.selectRow = {
            id: 'd2',
            workspaceId: WS,
            status: 'pending',
            attractorId: 'a2',
            attractorLabel: 'verify',
            currentPosition: [],
            proposedPosition: [],
            semanticDistance: 0,
            threshold: 0,
            source: 's',
            createdAt: new Date(),
        }
        const res = await fetch(`${baseUrl}/api/v1/scl/drift-warnings/d2/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.status).toBe('rejected')
    })

    it('returns 404 when missing', async () => {
        ctl.selectRow = null
        const res = await fetch(`${baseUrl}/api/v1/scl/drift-warnings/missing/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(404)
    })
})
