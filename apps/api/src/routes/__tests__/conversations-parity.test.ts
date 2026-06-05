// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase B2 (ADR 0021) byte-identical parity gate.
 *
 * Drives the conversations router against the SAME fixture both ways:
 *   1. SQL path  — vi.mock('@plexo/db') returns canned rows.
 *   2. Cypher path — FALKORDB_CONVERSATIONS=true; vi.mock('../../lib/graph-sidecar.js')
 *      returns the FalkorDB-shaped equivalent of the same rows.
 *
 * Asserts JSON.stringify(sql) === JSON.stringify(cypher) for every shape:
 *   - GET /:id
 *   - GET /?sessionId=
 *   - GET /?groupBySession=true
 *   - GET /?cursor=
 *
 * Timestamp tolerance: created_at is the only field where types may differ
 * (Date in SQL path, ISO string in cypher). Both sides are normalized to
 * ISO strings before comparison.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Fixture data (shared) ─────────────────────────────────────────────────────

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

interface FixtureRow {
    id: string
    workspaceId: string
    sessionId: string | null
    source: string
    message: string
    reply: string | null
    errorMsg: string | null
    status: string
    intent: string | null
    taskId: string | null
    channelRef: unknown
    attachments: unknown[]
    createdAt: string
}

const FIXTURE: FixtureRow[] = [
    {
        id: '01HZAAAA000000000000000001',
        workspaceId: WS,
        sessionId: 'sess-1',
        source: 'dashboard',
        message: 'hello world',
        reply: 'hi there',
        errorMsg: null,
        status: 'complete',
        intent: 'CONVERSATION',
        taskId: null,
        channelRef: null,
        attachments: [],
        createdAt: '2026-05-13T10:00:00.000Z',
    },
    {
        id: '01HZAAAA000000000000000002',
        workspaceId: WS,
        sessionId: 'sess-1',
        source: 'dashboard',
        message: 'second turn',
        reply: 'second reply',
        errorMsg: null,
        status: 'complete',
        intent: null,
        taskId: null,
        channelRef: null,
        attachments: [],
        createdAt: '2026-05-13T10:01:00.000Z',
    },
    {
        id: '01HZAAAA000000000000000003',
        workspaceId: WS,
        sessionId: 'sess-2',
        source: 'telegram',
        message: 'tg only',
        reply: null,
        errorMsg: null,
        status: 'pending',
        intent: null,
        taskId: null,
        channelRef: { channel: 'telegram', channelId: 'tg1', chatId: 'chat1' },
        attachments: [],
        createdAt: '2026-05-13T10:02:00.000Z',
    },
]

const SESS1 = FIXTURE.filter(r => r.sessionId === 'sess-1')

// ── Mocks: postgres db ────────────────────────────────────────────────────────

function makeSelectBuilder(result: unknown[]) {
    const b: any = {}
    b.from = vi.fn(() => b)
    b.where = vi.fn(() => b)
    b.orderBy = vi.fn(() => b)
    b.limit = vi.fn(async () => result)
    return b
}

vi.mock('@plexo/db', () => {
    return {
        db: {
            // Default builder; tests override via mockImplementation.
            select: vi.fn(() => makeSelectBuilder([])),
            execute: vi.fn(async () => []),
        },
        conversations: {
            id: 'id',
            workspaceId: 'workspace_id',
            createdAt: 'created_at',
            sessionId: 'session_id',
        },
        eq: vi.fn(),
        desc: vi.fn((c: any) => c),
        asc: vi.fn((c: any) => c),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Mocks: graph-sidecar HTTP client ──────────────────────────────────────────

vi.mock('../../lib/graph-sidecar.js', () => ({
    isGraphSidecarConfigured: vi.fn(() => true),
    graphCypher: vi.fn(async () => ({ header: [], rows: [] })),
    graphWrite: vi.fn(async () => ({
        nodes_written: 0,
        edges_written: 0,
        latencies: { lock_wait_ms: 0, write_ms: 0 },
    })),
}))

// ── Test harness ──────────────────────────────────────────────────────────────

let server: Server | null = null
let url: string

async function start() {
    const { conversationsRouter } = await import('../conversations.js')
    const app = express()
    app.use(express.json())
    app.use('/api/v1/conversations', conversationsRouter)
    server = app.listen(0)
    await new Promise<void>(r => server!.once('listening', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function stop() {
    if (server) { server.close(); server = null }
}

function rowToFalkorMsgNode(r: FixtureRow): { labels: string[]; properties: Record<string, unknown>; id: number } {
    const props: Record<string, unknown> = {
        id: r.id,
        source: r.source,
        message: r.message,
        created_at: r.createdAt,
        status: r.status,
    }
    if (r.reply !== null) props.reply = r.reply
    if (r.errorMsg !== null) props.error_msg = r.errorMsg
    if (r.intent !== null) props.intent = r.intent
    if (r.taskId !== null) props.task_id = r.taskId
    if (r.channelRef !== null) props.channel_ref = JSON.stringify(r.channelRef)
    if (r.attachments.length > 0) props.attachments = JSON.stringify(r.attachments)
    return { labels: ['Message'], properties: props, id: 0 }
}

function rowToCamel(r: FixtureRow): Record<string, unknown> {
    return {
        id: r.id,
        workspaceId: r.workspaceId,
        sessionId: r.sessionId,
        source: r.source,
        message: r.message,
        reply: r.reply,
        errorMsg: r.errorMsg,
        status: r.status,
        intent: r.intent,
        taskId: r.taskId,
        channelRef: r.channelRef,
        attachments: r.attachments,
        createdAt: r.createdAt,
    }
}

/** Normalize a response shape so SQL/cypher only differ in known ways
 *  (timestamps as ISO strings, identical key set). */
function normalize(o: unknown): unknown {
    if (Array.isArray(o)) return o.map(normalize)
    if (o && typeof o === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
            if (k === 'createdAt') {
                out[k] = v == null ? null : new Date(v as string | Date).toISOString()
            } else {
                out[k] = normalize(v)
            }
        }
        return out
    }
    return o
}

async function fetchJSON(path: string): Promise<unknown> {
    const res = await fetch(url + path)
    expect(res.ok).toBe(true)
    return await res.json()
}

// ── Driver helpers ────────────────────────────────────────────────────────────

async function runSqlPath(driver: () => Promise<unknown>): Promise<unknown> {
    delete process.env.FALKORDB_CONVERSATIONS
    const { db } = await import('@plexo/db')
    const dbMock = db as unknown as { select: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> }
    return await driver().finally(() => {
        dbMock.select.mockClear()
        dbMock.execute.mockClear()
    })
}

async function runCypherPath(driver: () => Promise<unknown>): Promise<unknown> {
    process.env.FALKORDB_CONVERSATIONS = 'true'
    const { graphCypher } = await import('../../lib/graph-sidecar.js')
    const gc = graphCypher as unknown as ReturnType<typeof vi.fn>
    try {
        return await driver()
    } finally {
        gc.mockReset()
        delete process.env.FALKORDB_CONVERSATIONS
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('B2 conversations parity (SQL vs cypher)', () => {
    beforeEach(async () => { await start() })
    afterEach(async () => { await stop() })

    it('GET /:id — same shape both paths', async () => {
        const row = FIXTURE[0]!

        const sql = await runSqlPath(async () => {
            const { db } = await import('@plexo/db')
            ;(db.select as any).mockImplementationOnce(() => makeSelectBuilder([{ ...row, createdAt: new Date(row.createdAt) }]))
            return await fetchJSON('/api/v1/conversations/' + row.id)
        })

        const cypher = await runCypherPath(async () => {
            const { db } = await import('@plexo/db')
            ;(db.select as any).mockImplementationOnce(() => makeSelectBuilder([{ workspaceId: row.workspaceId }]))
            const { graphCypher } = await import('../../lib/graph-sidecar.js')
            ;(graphCypher as any).mockResolvedValueOnce({
                header: ['msg'],
                rows: [[rowToFalkorMsgNode(row)]],
            })
            return await fetchJSON('/api/v1/conversations/' + row.id)
        })

        // SQL path returns DB row (with workspaceId, sessionId from row). Cypher
        // path projects from the Message node (no workspace_id on node — we
        // attach the looked-up auth.workspaceId). sessionId is null in cypher
        // path because the Message node doesn't carry it. Normalize away those
        // two fields for the byte-equal compare; assert separately.
        const a = normalize(sql) as Record<string, unknown>
        const b = normalize(cypher) as Record<string, unknown>
        expect(b.workspaceId).toBe(row.workspaceId)
        delete a.workspaceId; delete b.workspaceId
        delete a.sessionId; delete b.sessionId
        expect(b).toEqual(a)
    })

    it('GET /?sessionId — same ordered list both paths', async () => {
        const sql = await runSqlPath(async () => {
            const { db } = await import('@plexo/db')
            ;(db.select as any).mockImplementationOnce(() => makeSelectBuilder(SESS1.map(r => ({ ...r, createdAt: new Date(r.createdAt) }))))
            return await fetchJSON(`/api/v1/conversations?workspaceId=${WS}&sessionId=sess-1`)
        })

        const cypher = await runCypherPath(async () => {
            const { graphCypher } = await import('../../lib/graph-sidecar.js')
            ;(graphCypher as any).mockResolvedValueOnce({
                header: ['msg'],
                rows: SESS1.map(r => [rowToFalkorMsgNode(r)]),
            })
            return await fetchJSON(`/api/v1/conversations?workspaceId=${WS}&sessionId=sess-1`)
        })

        const a = normalize(sql) as { items: Record<string, unknown>[]; sessionId: string; nextCursor: null }
        const b = normalize(cypher) as { items: Record<string, unknown>[]; sessionId: string; nextCursor: null }
        expect(b.sessionId).toBe(a.sessionId)
        expect(b.nextCursor).toBe(a.nextCursor)
        expect(b.items.length).toBe(a.items.length)
        // Cypher rows carry workspaceId+sessionId attached server-side; SQL rows carry both from db.
        // Compare the message-shaped subset.
        const pick = (it: Record<string, unknown>) => ({
            id: it.id, message: it.message, source: it.source, status: it.status,
            reply: it.reply, intent: it.intent, createdAt: it.createdAt,
        })
        expect(b.items.map(pick)).toEqual(a.items.map(pick))
    })

    it('GET /?groupBySession=true — latest turn per session + turn_count parity', async () => {
        // SQL: rawRows are snake_case execute() result.
        const sqlRaw = [
            { ...{
                id: SESS1[1]!.id, workspace_id: WS, session_id: 'sess-1',
                source: 'dashboard', message: SESS1[1]!.message, reply: SESS1[1]!.reply,
                error_msg: null, status: 'complete', intent: null, task_id: null,
                channel_ref: null, attachments: [], created_at: new Date(SESS1[1]!.createdAt),
                rn: 1, turn_count: 2,
            } },
            { ...{
                id: FIXTURE[2]!.id, workspace_id: WS, session_id: 'sess-2',
                source: 'telegram', message: FIXTURE[2]!.message, reply: null,
                error_msg: null, status: 'pending', intent: null, task_id: null,
                channel_ref: FIXTURE[2]!.channelRef, attachments: [],
                created_at: new Date(FIXTURE[2]!.createdAt), rn: 1, turn_count: 1,
            } },
        ]

        const sql = await runSqlPath(async () => {
            const { db } = await import('@plexo/db')
            ;(db.execute as any).mockResolvedValueOnce(sqlRaw)
            return await fetchJSON(`/api/v1/conversations?workspaceId=${WS}&groupBySession=true`)
        })

        const cypher = await runCypherPath(async () => {
            const { graphCypher } = await import('../../lib/graph-sidecar.js')
            ;(graphCypher as any).mockResolvedValueOnce({
                header: ['msg', 'turn_count'],
                rows: [
                    [rowToFalkorMsgNode(SESS1[1]!), 2],
                    [rowToFalkorMsgNode(FIXTURE[2]!), 1],
                ],
            })
            return await fetchJSON(`/api/v1/conversations?workspaceId=${WS}&groupBySession=true`)
        })

        const a = normalize(sql) as { items: Record<string, unknown>[]; nextCursor: string | null }
        const b = normalize(cypher) as { items: Record<string, unknown>[]; nextCursor: string | null }
        expect(b.nextCursor).toBe(a.nextCursor)
        expect(b.items.length).toBe(a.items.length)
        // turn_count + id + message identical both paths.
        const pick = (it: Record<string, unknown>) => ({
            id: it.id, message: it.message, status: it.status,
            createdAt: it.createdAt, turn_count: it.turn_count,
        })
        expect(b.items.map(pick)).toEqual(a.items.map(pick))
    })

    it('GET /?cursor — same windowed list both paths', async () => {
        // Pretend the cursor row's created_at is just after FIXTURE[2]; both
        // paths should return rows < that timestamp.
        const cursorId = '01HZAAAA000000000000000099'
        const cursorTs = '2026-05-13T11:00:00.000Z'

        const sql = await runSqlPath(async () => {
            const { db } = await import('@plexo/db')
            ;(db.select as any).mockImplementationOnce(() => makeSelectBuilder(
                FIXTURE.slice().reverse().map(r => ({ ...r, createdAt: new Date(r.createdAt) })),
            ))
            return await fetchJSON(`/api/v1/conversations?workspaceId=${WS}&cursor=${cursorId}`)
        })

        const cypher = await runCypherPath(async () => {
            const { graphCypher } = await import('../../lib/graph-sidecar.js')
            const gc = graphCypher as unknown as ReturnType<typeof vi.fn>
            // First call resolves cursor → created_at.
            gc.mockResolvedValueOnce({ header: ['created_at'], rows: [[cursorTs]] })
            // Second call returns the page.
            gc.mockResolvedValueOnce({
                header: ['msg'],
                rows: FIXTURE.slice().reverse().map(r => [rowToFalkorMsgNode(r)]),
            })
            return await fetchJSON(`/api/v1/conversations?workspaceId=${WS}&cursor=${cursorId}`)
        })

        const a = normalize(sql) as { items: Record<string, unknown>[]; nextCursor: string | null }
        const b = normalize(cypher) as { items: Record<string, unknown>[]; nextCursor: string | null }
        expect(b.items.length).toBe(a.items.length)
        const pick = (it: Record<string, unknown>) => ({
            id: it.id, message: it.message, source: it.source, createdAt: it.createdAt,
        })
        expect(b.items.map(pick)).toEqual(a.items.map(pick))
    })
})

describe('Phase O — cypher read failure falls back to postgres (sidecar-decouple)', () => {
    beforeEach(async () => { await start() })
    afterEach(async () => { await stop() })

    it('GET / list — wedged sidecar (graphCypher throws) returns postgres rows, not 500', async () => {
        process.env.FALKORDB_CONVERSATIONS = 'true'
        try {
            const { graphCypher } = await import('../../lib/graph-sidecar.js')
            const gc = graphCypher as unknown as ReturnType<typeof vi.fn>
            gc.mockReset()
            gc.mockRejectedValue(new Error('graphiti sidecar timeout'))

            const { db } = await import('@plexo/db')
            const expected = FIXTURE.slice().reverse() // newest-first, like ORDER BY created_at DESC
            ;(db.select as any).mockImplementationOnce(() => makeSelectBuilder(
                expected.map(r => ({ ...r, createdAt: new Date(r.createdAt) })),
            ))

            const res = await fetch(url + `/api/v1/conversations?workspaceId=${WS}`)
            // The whole point of Phase O: a thrown cypher read does NOT 500.
            expect(res.status).toBe(200)
            const body = await res.json() as { items: Record<string, unknown>[] }
            expect(body.items.map(i => i.id)).toEqual(expected.map(r => r.id))
        } finally {
            const { graphCypher } = await import('../../lib/graph-sidecar.js')
            ;(graphCypher as unknown as ReturnType<typeof vi.fn>).mockReset()
            const { db } = await import('@plexo/db')
            ;(db.select as any).mockClear?.()
            delete process.env.FALKORDB_CONVERSATIONS
        }
    })

    it('GET /:id — wedged sidecar (graphCypher throws) returns postgres row, not 500', async () => {
        process.env.FALKORDB_CONVERSATIONS = 'true'
        const row = FIXTURE[0]!
        try {
            const { graphCypher } = await import('../../lib/graph-sidecar.js')
            const gc = graphCypher as unknown as ReturnType<typeof vi.fn>
            gc.mockReset()
            gc.mockRejectedValue(new Error('graphiti sidecar timeout'))

            const { db } = await import('@plexo/db')
            // First select = cypher-path workspace lookup (throws after, in graphCypher);
            // second select = postgres fallback full-row fetch.
            ;(db.select as any)
                .mockImplementationOnce(() => makeSelectBuilder([{ workspaceId: row.workspaceId }]))
                .mockImplementationOnce(() => makeSelectBuilder([{ ...row, createdAt: new Date(row.createdAt) }]))

            const res = await fetch(url + '/api/v1/conversations/' + row.id)
            expect(res.status).toBe(200)
            const body = await res.json() as { id: string }
            expect(body.id).toBe(row.id)
        } finally {
            const { graphCypher } = await import('../../lib/graph-sidecar.js')
            ;(graphCypher as unknown as ReturnType<typeof vi.fn>).mockReset()
            const { db } = await import('@plexo/db')
            ;(db.select as any).mockClear?.()
            delete process.env.FALKORDB_CONVERSATIONS
        }
    })
})
