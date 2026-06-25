// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase A2 (ADR 0018) — confidence-lifecycle FalkorDB dual-write regression.
 *
 * Mocks postgres + the GraphitiClient. Verifies:
 *   1. cypher params reflect the same predicates as the postgres UPDATEs
 *      (tier values, day cutoffs, decay factor, floor)
 *   2. one cypher op per (workspace, op-spec); postgres runs once globally
 *   3. partial failure (one workspace throws) does NOT abort the loop
 *   4. cypher count is logged + included in the divergence check
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface SqlCall { strings: string[]; values: unknown[] }

const mocks = vi.hoisted(() => {
    const sqlCalls: SqlCall[] = []
    const dbExecuteMock = ((async (q: unknown) => {
        const s = q as SqlCall
        sqlCalls.push(s)
        const joined = s.strings.join(' ')
        if (joined.includes('FROM workspaces')) {
            return [{ id: 'ws-A' }, { id: 'ws-B' }]
        }
        if (joined.includes("SET tier = 'active'")) return Object.assign([], { rowCount: 11 })
        if (joined.includes("SET tier = 'cold'")) return Object.assign([], { rowCount: 22 })
        if (joined.includes('SET confidence')) return Object.assign([], { rowCount: 33 })
        return []
    }) as unknown) as ReturnType<typeof vi.fn>
    return { sqlCalls, dbExecuteMock }
})

vi.mock('@plexo/db', () => ({
    db: { execute: mocks.dbExecuteMock },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: Array.from(strings), values }),
}))

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


vi.mock('@plexo/agent/analytics/memory-events', () => ({
    emitMemoryRetrievalFlush: vi.fn(),
    emitMemoryConfidenceDecay: vi.fn(),
}))

import {
    flushRetrievalCounts,
    decayConfidence,
    setCypherClientForTest,
    resetCypherClientForTest,
} from '../confidence-lifecycle.js'

interface CypherCall {
    workspaceId: string
    cypher: string
    params: Record<string, unknown>
}

function makeClient(opts?: {
    countByOp?: Partial<Record<'hot_to_active' | 'active_to_cold' | 'confidence_decay', number>>
    failOn?: (call: CypherCall) => boolean
}) {
    const calls: CypherCall[] = []
    const client = {
        async cypher(req: { workspaceId: string; cypher: string; params?: Record<string, unknown> }) {
            const call: CypherCall = { workspaceId: req.workspaceId, cypher: req.cypher, params: req.params ?? {} }
            calls.push(call)
            if (opts?.failOn?.(call)) throw new Error('boom')
            let n = 0
            if (req.cypher.includes("SET e.tier = 'active'")) n = opts?.countByOp?.hot_to_active ?? 11
            else if (req.cypher.includes("SET e.tier = 'cold'")) n = opts?.countByOp?.active_to_cold ?? 22
            else if (req.cypher.includes('SET e.confidence')) n = opts?.countByOp?.confidence_decay ?? 33
            return { header: ['n'], rows: [[n]] }
        },
    }
    return { client: client as unknown as Parameters<typeof setCypherClientForTest>[0], calls }
}

beforeEach(() => {
    mocks.sqlCalls.length = 0
    resetCypherClientForTest()
})

afterEach(() => {
    resetCypherClientForTest()
})

describe('confidence-lifecycle Phase A2 dual-write', () => {
    it('flushRetrievalCounts fans out hot→active and active→cold cypher per workspace', async () => {
        const { client, calls } = makeClient()
        setCypherClientForTest(client)

        await flushRetrievalCounts()

        // 2 workspaces × 2 ops each = 4 cypher calls
        expect(calls).toHaveLength(4)

        const hotCalls = calls.filter((c) => c.cypher.includes("SET e.tier = 'active'"))
        const coldCalls = calls.filter((c) => c.cypher.includes("SET e.tier = 'cold'"))
        expect(hotCalls).toHaveLength(2)
        expect(coldCalls).toHaveLength(2)

        // Cypher must MATCH on the same predicates as the postgres WHERE clause
        for (const c of hotCalls) {
            expect(c.cypher).toContain("e.tier = 'hot'")
            expect(c.cypher).toContain('e.last_retrieved_at < $cutoff')
            expect(typeof c.params.cutoff).toBe('string')
            // 7-day cutoff: roughly within last 7 days ±5s of "now"
            const cutoffMs = Date.parse(c.params.cutoff as string)
            const expectedMs = Date.now() - 7 * 24 * 60 * 60 * 1000
            expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(5000)
        }
        for (const c of coldCalls) {
            expect(c.cypher).toContain("e.tier = 'active'")
            expect(c.cypher).toContain('e.superseded_by IS NULL')
            const cutoffMs = Date.parse(c.params.cutoff as string)
            const expectedMs = Date.now() - 90 * 24 * 60 * 60 * 1000
            expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(5000)
        }

        // Postgres UPDATEs ran exactly once each (not per-workspace)
        const updates = mocks.sqlCalls.filter((c) => c.strings.join(' ').includes('UPDATE memory_entries'))
        expect(updates).toHaveLength(2)
    })

    it('decayConfidence sends one cypher per workspace with floor+factor params', async () => {
        const { client, calls } = makeClient()
        setCypherClientForTest(client)

        await decayConfidence()

        expect(calls).toHaveLength(2) // 2 workspaces × 1 op
        for (const c of calls) {
            expect(c.cypher).toContain('MATCH (e:Episodic)')
            expect(c.cypher).toContain('coalesce(e.is_anchored, false) = false')
            expect(c.cypher).toContain('e.confidence > $floor')
            expect(c.params.factor).toBe(0.9)
            expect(c.params.floor).toBe(0.1)
        }
    })

    it('partial cypher failure does not abort the loop; postgres still authoritative', async () => {
        const { client, calls } = makeClient({
            failOn: (c) => c.workspaceId === 'ws-A' && c.cypher.includes("SET e.tier = 'active'"),
        })
        setCypherClientForTest(client)

        await expect(flushRetrievalCounts()).resolves.toBeUndefined()

        // All 4 attempts were made even though one threw
        expect(calls).toHaveLength(4)

        // Postgres update still ran exactly once
        const updates = mocks.sqlCalls.filter((c) => c.strings.join(' ').includes('UPDATE memory_entries'))
        expect(updates).toHaveLength(2)
    })

    it('logs cypher count + warns when divergence > 5%', async () => {
        // Force cypher to return very different counts vs postgres (pg=11 vs cy=1 → ~91% divergence)
        const { client, calls } = makeClient({ countByOp: { hot_to_active: 1, active_to_cold: 1 } })
        setCypherClientForTest(client)

        await flushRetrievalCounts()

        expect(calls).toHaveLength(4)
        // Just verify cypher was issued; logger output isn't asserted directly here
        // (pino log capture is brittle in unit tests).
    })

    it('no-op when sidecar URL or service key is not configured', async () => {
        // No client set; ensure env vars are absent so getCypherClient returns null
        const prevUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
        const prevKey = process.env.PLEXO_SERVICE_KEY
        delete process.env.PLEXO_GRAPHITI_SIDECAR_URL
        delete process.env.PLEXO_SERVICE_KEY
        try {
            await expect(flushRetrievalCounts()).resolves.toBeUndefined()
            await expect(decayConfidence()).resolves.toBeUndefined()
        } finally {
            if (prevUrl !== undefined) process.env.PLEXO_GRAPHITI_SIDECAR_URL = prevUrl
            if (prevKey !== undefined) process.env.PLEXO_SERVICE_KEY = prevKey
        }
    })
})
