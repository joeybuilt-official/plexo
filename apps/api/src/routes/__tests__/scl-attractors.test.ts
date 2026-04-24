// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3b — attractor browser endpoint tests.
 *
 * Pins:
 *   1. GET /attractors returns workspace concept graphs
 *   2. GET /attractors filters by domain region
 *   3. GET /attractors free-text query narrows results
 *   4. GET /attractors/:id returns full graph_json + mindset_object
 *   5. GET /attractors/:id returns 404 for unknown id
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    listRows: [] as any[],
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
                if (rendered.includes('graph_json')) {
                    return { rows: ctl.detailRow ? [ctl.detailRow] : [] }
                }
                if (rendered.includes('FROM scl_concept_graphs')) {
                    return { rows: ctl.listRows }
                }
                return { rows: [] }
            }),
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

const SAMPLE_LIST = [
    { id: 'a1', source_log_id: 'log-1', domain_region: 'code', created_at: new Date().toISOString(), updated_at: null },
    { id: 'a2', source_log_id: 'log-2', domain_region: 'product', created_at: new Date().toISOString(), updated_at: null },
    { id: 'b3', source_log_id: 'log-3', domain_region: 'code', created_at: new Date().toISOString(), updated_at: null },
]

describe('GET /api/v1/scl/attractors', () => {
    it('returns workspace concept graphs', async () => {
        ctl.listRows = [...SAMPLE_LIST]
        const res = await fetch(`${baseUrl}/api/v1/scl/attractors?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.attractors).toHaveLength(3)
        expect(body.total).toBe(3)
    })

    it('narrows results when query matches an id', async () => {
        ctl.listRows = [...SAMPLE_LIST]
        const res = await fetch(`${baseUrl}/api/v1/scl/attractors?workspaceId=${WS}&query=b3`)
        const body = await res.json() as any
        expect(body.attractors).toHaveLength(1)
        expect(body.attractors[0].id).toBe('b3')
    })

    it('narrows results when query matches a domain region', async () => {
        ctl.listRows = [...SAMPLE_LIST]
        const res = await fetch(`${baseUrl}/api/v1/scl/attractors?workspaceId=${WS}&query=product`)
        const body = await res.json() as any
        expect(body.attractors).toHaveLength(1)
        expect(body.attractors[0].domainRegion).toBe('product')
    })
})

describe('GET /api/v1/scl/attractors/:id', () => {
    it('returns the full graph_json + mindset_object', async () => {
        ctl.detailRow = {
            id: 'a1',
            source_log_id: 'log-1',
            workspace_id: WS,
            domain_region: 'code',
            graph_json: { nodes: [{ id: 'n1', label: 'plan' }], edges: [] },
            mindset_object: { spirit: 'careful' },
            created_at: new Date().toISOString(),
            updated_at: null,
        }
        const res = await fetch(`${baseUrl}/api/v1/scl/attractors/a1?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.attractor.id).toBe('a1')
        expect(body.attractor.graphJson.nodes).toHaveLength(1)
        expect(body.attractor.mindsetObject.spirit).toBe('careful')
    })

    it('returns 404 when missing', async () => {
        ctl.detailRow = null
        const res = await fetch(`${baseUrl}/api/v1/scl/attractors/missing?workspaceId=${WS}`)
        expect(res.status).toBe(404)
    })
})
