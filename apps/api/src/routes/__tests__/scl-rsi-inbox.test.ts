// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3b — RSI proposals inbox tests.
 *
 * Pins:
 *   1. GET /rsi-proposals returns rows + counts
 *   2. POST /approve transitions pending → approved
 *   3. POST /reject transitions pending → rejected
 *   4. Approve refuses already-resolved proposals
 *   5. Workspace mismatch returns 403
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    listRows: [] as any[],
    countRows: [] as any[],
    detailRow: null as any,
    executedSql: [] as any[],
}

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => []),
    }
    return {
        db: {
            select: vi.fn(() => builder),
            execute: vi.fn(async (q: any) => {
                ctl.executedSql.push(q)
                const rendered = (q?.strings ?? []).join(' ')
                if (rendered.includes('GROUP BY status')) return { rows: ctl.countRows }
                if (rendered.includes('SELECT id, workspace_id, status')) {
                    return { rows: ctl.detailRow ? [ctl.detailRow] : [] }
                }
                if (rendered.includes('FROM rsi_proposals')) return { rows: ctl.listRows }
                if (rendered.includes('UPDATE rsi_proposals')) return { rows: [] }
                return { rows: [] }
            }),
            update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
        },
        sclDriftWarnings: {},
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
    loadGoldenRecord: vi.fn(async () => null),
    saveGoldenRecord: vi.fn(async () => undefined),
}))

vi.mock('@plexo/scl-core', () => ({
    resolveDrift: vi.fn((r: any) => r),
}))

let server: Server | null = null
let baseUrl: string

beforeEach(async () => {
    ctl.listRows = []
    ctl.countRows = []
    ctl.detailRow = null
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

describe('GET /api/v1/scl/rsi-proposals', () => {
    it('returns proposals + counts', async () => {
        ctl.listRows = [
            {
                id: 'r1', anomaly_type: 'high_token_low_score', hypothesis: 'try cheaper model',
                proposed_change: { model: 'haiku' }, risk: 'low', status: 'pending',
                approved_at: null, rejected_at: null, created_at: new Date().toISOString(),
            },
        ]
        ctl.countRows = [{ status: 'pending', count: 1 }]
        const res = await fetch(`${baseUrl}/api/v1/scl/rsi-proposals?workspaceId=${WS}`)
        const body = await res.json() as any
        expect(res.status).toBe(200)
        expect(body.proposals).toHaveLength(1)
        expect(body.proposals[0].anomalyType).toBe('high_token_low_score')
        expect(body.counts.pending).toBe(1)
    })

    it('rejects unknown status', async () => {
        const res = await fetch(`${baseUrl}/api/v1/scl/rsi-proposals?workspaceId=${WS}&status=garbage`)
        expect(res.status).toBe(400)
    })
})

describe('POST /api/v1/scl/rsi-proposals/:id/approve', () => {
    it('transitions pending → approved', async () => {
        ctl.detailRow = { id: 'r1', workspace_id: WS, status: 'pending' }
        const res = await fetch(`${baseUrl}/api/v1/scl/rsi-proposals/r1/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.status).toBe('approved')
    })

    it('returns 400 when already resolved', async () => {
        ctl.detailRow = { id: 'r1', workspace_id: WS, status: 'approved' }
        const res = await fetch(`${baseUrl}/api/v1/scl/rsi-proposals/r1/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
    })

    it('returns 403 on workspace mismatch', async () => {
        ctl.detailRow = { id: 'r1', workspace_id: 'other-ws', status: 'pending' }
        const res = await fetch(`${baseUrl}/api/v1/scl/rsi-proposals/r1/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(403)
    })
})

describe('POST /api/v1/scl/rsi-proposals/:id/reject', () => {
    it('transitions pending → rejected', async () => {
        ctl.detailRow = { id: 'r2', workspace_id: WS, status: 'pending' }
        const res = await fetch(`${baseUrl}/api/v1/scl/rsi-proposals/r2/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.status).toBe('rejected')
    })

    it('returns 404 when missing', async () => {
        ctl.detailRow = null
        const res = await fetch(`${baseUrl}/api/v1/scl/rsi-proposals/missing/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(404)
    })
})
