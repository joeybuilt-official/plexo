// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2b — chain endpoint tests.
 *
 * Mounts the intelligence router on a tiny express instance and drives
 * the GET/PATCH/POST chain handlers via fetch. All external I/O (db
 * reads + writes, intelligence-cache, intelligence-spend, cost-enforcement,
 * seed-routing-chains, chain-resolver) is stubbed via vi.mock so the
 * suite is hermetic.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    chainRows: [
        { id: 'r1', task_type: 'conversation', provider_id: 'p1', model_id: 'claude-haiku-4-5', position: 0 },
        { id: 'r2', task_type: 'conversation', provider_id: 'p2', model_id: 'deepseek-chat', position: 1 },
        { id: 'r3', task_type: 'planning', provider_id: 'p1', model_id: 'claude-sonnet-4-5', position: 0 },
    ] as any[],
    executedSql: [] as any[],
    invalidatedSettings: [] as string[],
    invalidatedSpend: [] as string[],
    invalidatedChainCache: [] as string[],
    cleared: [] as string[],
    resetCalls: [] as Array<{ ws: string; tt: string }>,
}

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => [{ s: {} }]),
    }
    const executeFn = vi.fn(async (q: any) => {
        ctl.executedSql.push(q)
        // The chain GET issues a single SELECT — surface ctl.chainRows
        // when the SQL contains 'FROM routing_chains'.
        const rendered = (q?.strings ?? []).join(' ')
        if (rendered.includes('FROM routing_chains')) {
            return { rows: ctl.chainRows }
        }
        return { rows: [] }
    })
    return {
        db: {
            select: vi.fn(() => builder),
            execute: executeFn,
            transaction: vi.fn(async (fn: any) => {
                const tx = { execute: executeFn }
                return fn(tx)
            }),
        },
        workspaces: { intelligenceSettings: 'intelligence_settings' },
        eq: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

// ADR-0045 Phase 2: source imports drizzle operators from 'drizzle-orm' now.
// Mirror whatever operator stubs the @plexo/db mock defines so the fake db
// still sees the same recognizable shapes (fall back to real drizzle otherwise).
vi.mock('drizzle-orm', async (importOriginal) => {
    const real = await importOriginal<Record<string, unknown>>()
    const m = (await import('@plexo/db')) as Record<string, unknown>
    const pick = (k: string): unknown => (k in m ? m[k] : real[k])
    return {
        ...real,
        eq: pick('eq'), and: pick('and'), or: pick('or'), ne: pick('ne'),
        desc: pick('desc'), asc: pick('asc'), inArray: pick('inArray'),
        isNull: pick('isNull'), isNotNull: pick('isNotNull'), ilike: pick('ilike'),
        lt: pick('lt'), lte: pick('lte'), gte: pick('gte'), count: pick('count'),
        sql: pick('sql'),
    }
})


vi.mock('../../lib/intelligence-cache.js', () => ({
    invalidateIntelligenceSettings: vi.fn((id: string) => { ctl.invalidatedSettings.push(id) }),
}))

vi.mock('../../lib/intelligence-spend.js', () => ({
    getWorkspaceSpend: vi.fn(async () => ({})),
    invalidateWorkspaceSpend: vi.fn((id: string) => { ctl.invalidatedSpend.push(id) }),
}))

vi.mock('../../middleware/cost-enforcement.js', () => ({
    evaluateCostCeiling: vi.fn(async () => ({
        state: 'ok',
        usagePct: 0,
        ceilingUsd: null,
        spend: {},
        reason: 'soft_warn_80',
    })),
    clearWarnedWorkspace: vi.fn((id: string) => { ctl.cleared.push(id) }),
}))

vi.mock('../../middleware/workspace-access.js', () => ({
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../lib/seed-routing-chains.js', () => ({
    resetWorkspaceTaskChain: vi.fn(async (ws: string, tt: string) => {
        ctl.resetCalls.push({ ws, tt })
        return { rowsInserted: 3 }
    }),
}))

vi.mock('@plexo/agent/providers/chain-resolver', () => ({
    invalidateChainResolver: vi.fn((id: string) => { ctl.invalidatedChainCache.push(id) }),
}))

let server: Server | null = null
let baseUrl: string

beforeEach(async () => {
    ctl.executedSql = []
    ctl.invalidatedSettings = []
    ctl.invalidatedSpend = []
    ctl.invalidatedChainCache = []
    ctl.cleared = []
    ctl.resetCalls = []
    if (!server) {
        const { intelligenceRouter } = await import('../intelligence.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/intelligence', intelligenceRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

const WS = 'ws-1'

describe('GET /api/v1/intelligence/:workspaceId/chains', () => {
    it('returns chains grouped by task type with task type list', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/${WS}/chains`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.taskTypes).toEqual(expect.arrayContaining([
            'planning', 'codeGeneration', 'verification',
            'summarization', 'conversation', 'classification', 'logAnalysis',
        ]))
        expect(body.chains.conversation).toHaveLength(2)
        expect(body.chains.conversation[0].modelId).toBe('claude-haiku-4-5')
        expect(body.chains.planning).toHaveLength(1)
        expect(body.chains.codeGeneration).toEqual([])
    })
})

describe('PATCH /api/v1/intelligence/:workspaceId/chains/:taskType', () => {
    it('writes the new chain in order and invalidates caches', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entries: [
                    { providerId: 'p1', modelId: 'claude-haiku-4-5' },
                    { providerId: 'p2', modelId: 'deepseek-chat' },
                ],
            }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.length).toBe(2)
        expect(ctl.invalidatedSettings).toContain(WS)
        expect(ctl.invalidatedChainCache).toContain(WS)
        // 1 DELETE + 2 INSERTs
        expect(ctl.executedSql.length).toBeGreaterThanOrEqual(3)
    })

    it('rejects unknown task types', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/${WS}/chains/unknownTier`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: [] }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects entries that are not arrays', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: 'nope' }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects malformed entry shapes', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: [{ providerId: 'p1' }] }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects oversized chains', async () => {
        const big = Array.from({ length: 11 }, (_, i) => ({ providerId: `p${i}`, modelId: 'm' }))
        const res = await fetch(`${baseUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: big }),
        })
        expect(res.status).toBe(400)
    })
})

describe('POST /api/v1/intelligence/:workspaceId/chains/:taskType/reset', () => {
    it('calls the seeder and busts the caches', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/${WS}/chains/codeGeneration/reset`, {
            method: 'POST',
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.rowsInserted).toBe(3)
        expect(ctl.resetCalls).toEqual([{ ws: WS, tt: 'codeGeneration' }])
        expect(ctl.invalidatedSettings).toContain(WS)
        expect(ctl.invalidatedChainCache).toContain(WS)
    })

    it('rejects unknown task types', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/${WS}/chains/whatever/reset`, {
            method: 'POST',
        })
        expect(res.status).toBe(400)
    })
})
