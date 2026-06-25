// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 8 — Escalation manager unit tests.
 *
 * Covers the core decision lifecycle (approve, reject, timeout), the
 * background sweeper, and start-of-process recovery. All DB writes are
 * served by an in-memory stub so the tests don't need a live postgres.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── In-memory DB stub ──────────────────────────────────────────────────────
// The manager code reaches for `db.insert(...).values(...).returning()` and
// `db.update(...).set(...).where(...).returning()`. Both are replaced with
// chainable functions that manipulate the local `rows` map.
//
// All stubs live inside `vi.hoisted(...)` so they exist before the
// `vi.mock(...)` factories execute (both blocks are hoisted to the top of
// the file together, in order).

interface Row {
    id: string
    workspaceId: string
    sessionId: string
    agentId: string | null
    toolName: string
    payload: unknown
    reason: string | null
    status: 'pending' | 'approved' | 'rejected' | 'timeout'
    requestedAt: Date
    decidedAt: Date | null
    decidedBy: string | null
    expiresAt: Date
    decisionNote: string | null
}

interface Predicate { fn: (r: Row) => boolean }

const hoisted = vi.hoisted(() => {
    const rows = new Map<string, Row>()
    const counter = { n: 0 }
    const emitSpy = vi.fn()

    const makeId = () => {
        counter.n++
        return `row-${counter.n}`
    }

    const insertBuilder = () => ({
        values(vals: Partial<Row>) {
            return {
                returning: async () => {
                    const row: Row = {
                        id: makeId(),
                        workspaceId: vals.workspaceId!,
                        sessionId: vals.sessionId!,
                        agentId: vals.agentId ?? null,
                        toolName: vals.toolName!,
                        payload: vals.payload ?? {},
                        reason: vals.reason ?? null,
                        status: 'pending',
                        requestedAt: new Date(),
                        decidedAt: null,
                        decidedBy: null,
                        expiresAt: vals.expiresAt!,
                        decisionNote: null,
                    }
                    rows.set(row.id, row)
                    return [row]
                },
            }
        },
    })

    const updateBuilder = () => {
        let setVals: Partial<Row> = {}
        let predicate: Predicate = { fn: () => true }
        const chain = {
            set(vals: Partial<Row>) {
                setVals = vals
                return chain
            },
            where(p: Predicate) {
                predicate = p
                return chain
            },
            returning: async (_cols?: unknown) => {
                void _cols
                const matched: Row[] = []
                for (const row of rows.values()) {
                    if (predicate.fn(row)) {
                        Object.assign(row, setVals)
                        matched.push(row)
                    }
                }
                return matched
            },
        }
        return chain
    }

    const fakeDb = {
        insert: (_table: unknown) => insertBuilder(),
        update: (_table: unknown) => updateBuilder(),
        select: (_cols?: unknown) => ({
            from: (_t: unknown) => ({
                where: (_p: unknown) => ({
                    limit: async (_n: number) => [],
                }),
            }),
        }),
    }

    const fakeAnd = (...predicates: Predicate[]): Predicate => ({
        fn: (r: Row) => predicates.every((p) => p.fn(r)),
    })
    const fakeEq = (col: { _name: string }, value: unknown): Predicate => ({
        fn: (r: Row) => (r as unknown as Record<string, unknown>)[col._name] === value,
    })
    const fakeLt = (col: { _name: string }, value: unknown): Predicate => ({
        fn: (r: Row) => {
            const v = (r as unknown as Record<string, unknown>)[col._name]
            if (v instanceof Date && value instanceof Date) return v.getTime() < value.getTime()
            return false
        },
    })

    const escalationRequestsStub = new Proxy({}, {
        get(_target, prop: string) {
            if (prop === '$inferSelect' || prop === '$inferInsert') return undefined
            return { _name: prop }
        },
    }) as unknown as Record<string, { _name: string }>

    return {
        rows,
        counter,
        emitSpy,
        fakeDb,
        fakeAnd,
        fakeEq,
        fakeLt,
        escalationRequestsStub,
    }
})

const { rows, counter, emitSpy } = hoisted

vi.mock('@plexo/db', () => ({
    db: hoisted.fakeDb,
    and: hoisted.fakeAnd,
    eq: hoisted.fakeEq,
    lt: hoisted.fakeLt,
    escalationRequests: hoisted.escalationRequestsStub,
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


vi.mock('../../audit.js', () => ({
    logAuditEntry: vi.fn(async () => undefined),
}))

vi.mock('../../plugins/event-bus.js', () => ({
    eventBus: { emitSystem: hoisted.emitSpy, subscribe: vi.fn(() => () => undefined) },
    TOPICS: {
        ESCALATION_REQUESTED: 'plexo.escalation.requested',
        ESCALATION_DECIDED: 'plexo.escalation.decided',
    },
}))

// ── Under test ─────────────────────────────────────────────────────────────

import {
    requestEscalation,
    approveEscalation,
    rejectEscalation,
    sweeperTick,
    recoverExpiredOnStartup,
    _stopEscalationSweeperForTests,
    _getPendingCountForTests,
} from '../manager.js'

function freshState() {
    rows.clear()
    counter.n = 0
    emitSpy.mockClear()
    _stopEscalationSweeperForTests()
}

beforeEach(() => freshState())
afterEach(() => _stopEscalationSweeperForTests())

describe('escalation manager', () => {
    it('resolves the waiting promise when approveEscalation fires', async () => {
        const pending = requestEscalation({
            workspaceId: '00000000-0000-0000-0000-000000000001',
            sessionId: 'sess-a',
            agentId: 'agent-1',
            toolName: 'stripe.refund',
            payload: { amount: 500 },
            reason: 'test',
            ttlMs: 60_000,
        })

        // Wait for the insert microtask to flush.
        await new Promise((r) => setImmediate(r))

        // Pull the just-inserted row id.
        const [row] = Array.from(rows.values())
        expect(row).toBeDefined()
        expect(row!.status).toBe('pending')
        expect(_getPendingCountForTests()).toBe(1)

        const decision = await approveEscalation(row!.id, 'user-123', 'looks fine')
        expect(decision).not.toBeNull()
        expect(decision!.status).toBe('approved')

        const resolved = await pending
        expect(resolved.status).toBe('approved')
        expect(resolved.decidedBy).toBe('user-123')
        expect(_getPendingCountForTests()).toBe(0)
    })

    it('resolves with denied status when rejectEscalation fires', async () => {
        const pending = requestEscalation({
            workspaceId: '00000000-0000-0000-0000-000000000002',
            sessionId: 'sess-b',
            toolName: 'gmail.send',
            payload: { to: 'a@example.com' },
            ttlMs: 60_000,
        })

        await new Promise((r) => setImmediate(r))
        const [row] = Array.from(rows.values())
        const decision = await rejectEscalation(row!.id, 'user-9', 'not now')
        expect(decision!.status).toBe('rejected')

        const resolved = await pending
        expect(resolved.status).toBe('rejected')
        expect(resolved.reason).toBe('not now')
    })

    it('times out when the TTL elapses', async () => {
        const pending = requestEscalation({
            workspaceId: '00000000-0000-0000-0000-000000000003',
            sessionId: 'sess-c',
            toolName: 'danger.op',
            payload: {},
            ttlMs: 50,
        })

        await new Promise((r) => setImmediate(r))
        // Before timeout the row is still pending.
        expect(_getPendingCountForTests()).toBe(1)
        expect(Array.from(rows.values())[0]!.status).toBe('pending')

        const resolved = await pending
        expect(resolved.status).toBe('timeout')
        // Allow one microtask flush for the DB update to commit + waiter cleanup.
        await new Promise((r) => setImmediate(r))
        expect(_getPendingCountForTests()).toBe(0)
        expect(Array.from(rows.values())[0]!.status).toBe('timeout')
    })

    it('sweeperTick ages out expired pending rows', async () => {
        // Insert a row by hand that's already past its expiry.
        const past = new Date(Date.now() - 60_000)
        const row: Row = {
            id: 'row-existing',
            workspaceId: '00000000-0000-0000-0000-000000000004',
            sessionId: 'sess-d',
            agentId: null,
            toolName: 'already.expired',
            payload: {},
            reason: null,
            status: 'pending',
            requestedAt: past,
            decidedAt: null,
            decidedBy: null,
            expiresAt: past,
            decisionNote: null,
        }
        rows.set(row.id, row)

        const count = await sweeperTick()
        expect(count).toBe(1)
        expect(rows.get('row-existing')!.status).toBe('timeout')
    })

    it('recoverExpiredOnStartup marks stale pending rows as timeout', async () => {
        const past = new Date(Date.now() - 120_000)
        rows.set('a', {
            id: 'a',
            workspaceId: '00000000-0000-0000-0000-000000000005',
            sessionId: 's1',
            agentId: null,
            toolName: 't1',
            payload: {},
            reason: null,
            status: 'pending',
            requestedAt: past,
            decidedAt: null,
            decidedBy: null,
            expiresAt: past,
            decisionNote: null,
        })
        rows.set('b', {
            id: 'b',
            workspaceId: '00000000-0000-0000-0000-000000000005',
            sessionId: 's2',
            agentId: null,
            toolName: 't2',
            payload: {},
            reason: null,
            status: 'pending',
            requestedAt: new Date(),
            decidedAt: null,
            decidedBy: null,
            // still in the future — must NOT be reaped
            expiresAt: new Date(Date.now() + 60_000),
            decisionNote: null,
        })

        const reaped = await recoverExpiredOnStartup()
        expect(reaped).toBe(1)
        expect(rows.get('a')!.status).toBe('timeout')
        expect(rows.get('b')!.status).toBe('pending')
    })

    it('approveEscalation returns null for an unknown or already-decided row', async () => {
        const result = await approveEscalation('does-not-exist', 'user-x')
        expect(result).toBeNull()
    })

    it('emits ESCALATION_REQUESTED and ESCALATION_DECIDED on the bus', async () => {
        const pending = requestEscalation({
            workspaceId: '00000000-0000-0000-0000-000000000006',
            sessionId: 's-bus',
            toolName: 'bus.check',
            payload: {},
            ttlMs: 60_000,
        })
        await new Promise((r) => setImmediate(r))
        const topics = emitSpy.mock.calls.map((c) => c[0])
        expect(topics).toContain('plexo.escalation.requested')

        const [row] = Array.from(rows.values())
        await approveEscalation(row!.id, 'user-bus')
        await pending

        const topicsAfter = emitSpy.mock.calls.map((c) => c[0])
        expect(topicsAfter).toContain('plexo.escalation.decided')
    })
})
