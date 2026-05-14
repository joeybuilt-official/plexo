// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Admin routes tests.
 *
 * Pins:
 *   1. GET /workspaces — merges task + member counts per workspace
 *   2. GET /workspaces/:id — 404 when workspace not found; full detail on success
 *   3. GET /users — isSuperAdmin derived from SUPER_ADMIN_EMAILS env
 *   4. GET /tasks — no-filter path; status filter; limit param respected
 *   5. GET /tasks/stats — returns byStatus map + lastWeek count
 *   6. GET /health — ok + counts; 500 on DB failure
 *   7. GET /connections — returns connections list
 *   8. GET /audit — respects limit query param
 *   9. POST /workspaces — 400 on missing name; 201 on success; 500 on DB failure
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── DB mock state ──────────────────────────────────────────────────────────

const dbQueue: unknown[] = []
let dbFail = false

function dequeue(): unknown {
    return dbQueue.shift() ?? []
}

function enqueue(...items: unknown[]): void {
    dbQueue.push(...items)
}

function makeChain(): Record<string, unknown> {
    const result: Promise<unknown> = dbFail
        ? Promise.reject(new Error('DB connection failed'))
        : Promise.resolve().then(dequeue)
    const chain: Record<string, unknown> = {
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            result.then(res, rej),
        catch: (rej: (e: unknown) => unknown) => result.catch(rej),
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        groupBy: () => chain,
        values: () => chain,
        limit: () => result,
        returning: () => result,
    }
    return chain
}

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        select: (_f?: unknown) => makeChain(),
        insert: (_t?: unknown) => makeChain(),
        execute: (_q?: unknown) =>
            dbFail
                ? Promise.reject(new Error('DB connection failed'))
                : Promise.resolve().then(dequeue),
    },
    eq: () => undefined,
    desc: () => undefined,
    count: () => undefined,
    sql: Object.assign(
        (_strings: TemplateStringsArray, ..._values: unknown[]) => ({}),
        { join: () => undefined },
    ),
    workspaces: {},
    tasks: {},
    users: {},
    workspaceMembers: {},
    installedConnections: {},
    auditLog: {},
    memoryEntries: {},
    conversations: {},
    attachmentScanQueue: {},
    DEFAULT_WORKSPACE_SETTINGS: {},
    DEFAULT_INTELLIGENCE_SETTINGS: {},
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server bootstrap ───────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string
const ADMIN_USER = { id: 'admin-user-id', email: 'admin@example.com', role: 'admin' as const, isSuperAdmin: true }

async function getServer(): Promise<string> {
    if (!server) {
        const { adminRouter } = await import('../admin.js')
        const app = express()
        app.use(express.json())
        app.use((req: express.Request, _res, next) => {
            (req as unknown as { user: typeof ADMIN_USER }).user = ADMIN_USER
            next()
        })
        app.use('/admin', adminRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((r) => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    dbQueue.length = 0
    dbFail = false
    delete process.env.SUPER_ADMIN_EMAILS
})

afterAll(() => { server?.close() })

// ── GET /workspaces ────────────────────────────────────────────────────────

describe('GET /admin/workspaces', () => {
    it('returns items with merged task and member counts', async () => {
        const base = await getServer()
        const wsRows = [
            { id: 'ws-1', name: 'Alpha', ownerId: 'u-1', createdAt: '2026-01-01T00:00:00Z' },
            { id: 'ws-2', name: 'Beta', ownerId: 'u-2', createdAt: '2026-01-02T00:00:00Z' },
        ]
        const taskCounts = [{ workspaceId: 'ws-1', total: 5 }]
        const memberCounts = [{ workspaceId: 'ws-2', total: 3 }]
        enqueue(wsRows, taskCounts, memberCounts)

        const res = await fetch(`${base}/admin/workspaces`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: Array<{ id: string; taskCount: number; memberCount: number }>; total: number }
        expect(body.total).toBe(2)

        const alpha = body.items.find((i) => i.id === 'ws-1')!
        const beta = body.items.find((i) => i.id === 'ws-2')!
        expect(alpha.taskCount).toBe(5)
        expect(alpha.memberCount).toBe(0)
        expect(beta.taskCount).toBe(0)
        expect(beta.memberCount).toBe(3)
    })

    it('returns 500 when the DB query fails', async () => {
        const base = await getServer()
        dbFail = true
        const res = await fetch(`${base}/admin/workspaces`)
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})

// ── GET /workspaces/:id ────────────────────────────────────────────────────

describe('GET /admin/workspaces/:id', () => {
    it('returns 404 when workspace not found', async () => {
        const base = await getServer()
        enqueue([]) // empty result → [ws] is undefined
        const res = await fetch(`${base}/admin/workspaces/non-existent-id`)
        expect(res.status).toBe(404)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('NOT_FOUND')
    })

    it('returns full workspace detail on success', async () => {
        const base = await getServer()
        const ws = { id: 'ws-1', name: 'Alpha', ownerId: 'u-1', createdAt: '2026-01-01T00:00:00Z' }
        const recentTasks = [{ id: 't-1', title: 'Fix bug', status: 'complete', type: 'task', createdAt: '2026-01-02T00:00:00Z' }]
        const connections = [{ id: 'c-1', type: 'github', name: 'GitHub', status: 'active' }]
        const members = [{ userId: 'u-1', role: 'admin' }]
        enqueue([ws], recentTasks, connections, members)

        const res = await fetch(`${base}/admin/workspaces/ws-1`)
        expect(res.status).toBe(200)
        const body = await res.json() as {
            workspace: typeof ws
            recentTasks: unknown[]
            connections: unknown[]
            members: unknown[]
        }
        expect(body.workspace.id).toBe('ws-1')
        expect(body.workspace.name).toBe('Alpha')
        expect(body.recentTasks).toHaveLength(1)
        expect(body.connections).toHaveLength(1)
        expect(body.members).toHaveLength(1)
    })
})

// ── GET /users ─────────────────────────────────────────────────────────────

describe('GET /admin/users', () => {
    it('marks isSuperAdmin true for emails in SUPER_ADMIN_EMAILS env', async () => {
        const base = await getServer()
        process.env.SUPER_ADMIN_EMAILS = 'super@example.com, admin@example.com'
        enqueue([
            { id: 'u-1', email: 'super@example.com', name: 'Super', role: 'admin', createdAt: '2026-01-01T00:00:00Z' },
            { id: 'u-2', email: 'regular@example.com', name: 'Regular', role: 'member', createdAt: '2026-01-01T00:00:00Z' },
        ])

        const res = await fetch(`${base}/admin/users`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: Array<{ id: string; isSuperAdmin: boolean }> }
        expect(body.items.find((u) => u.id === 'u-1')?.isSuperAdmin).toBe(true)
        expect(body.items.find((u) => u.id === 'u-2')?.isSuperAdmin).toBe(false)
    })

    it('marks isSuperAdmin false when SUPER_ADMIN_EMAILS is not set', async () => {
        const base = await getServer()
        enqueue([
            { id: 'u-1', email: 'user@example.com', name: 'User', role: 'member', createdAt: '2026-01-01T00:00:00Z' },
        ])

        const res = await fetch(`${base}/admin/users`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: Array<{ isSuperAdmin: boolean }> }
        expect(body.items[0]!.isSuperAdmin).toBe(false)
    })
})

// ── GET /tasks ─────────────────────────────────────────────────────────────

describe('GET /admin/tasks', () => {
    it('returns all tasks when no status filter', async () => {
        const base = await getServer()
        enqueue([
            { id: 't-1', title: 'Task A', status: 'complete', type: 'task', workspaceId: 'ws-1', createdAt: '2026-01-01T00:00:00Z', completedAt: null },
            { id: 't-2', title: 'Task B', status: 'running', type: 'task', workspaceId: 'ws-2', createdAt: '2026-01-02T00:00:00Z', completedAt: null },
        ])

        const res = await fetch(`${base}/admin/tasks`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: unknown[]; total: number }
        expect(body.total).toBe(2)
        expect(body.items).toHaveLength(2)
    })

    it('filters by status when status query param provided', async () => {
        const base = await getServer()
        // The route always creates `let query = db.select(...)` unconditionally,
        // consuming one queue slot before the status-filtered query runs.
        enqueue(
            [],  // consumed by the unused `query` variable
            [{ id: 't-1', title: 'Task A', status: 'complete', type: 'task', workspaceId: 'ws-1', createdAt: '2026-01-01T00:00:00Z', completedAt: null }],
        )

        const res = await fetch(`${base}/admin/tasks?status=complete`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: Array<{ status: string }>; total: number }
        expect(body.total).toBe(1)
        expect(body.items[0]!.status).toBe('complete')
    })

    it('caps limit at 200 even when a higher value is requested', async () => {
        const base = await getServer()
        enqueue([])

        const res = await fetch(`${base}/admin/tasks?limit=9999`)
        expect(res.status).toBe(200)
    })
})

// ── GET /tasks/stats ───────────────────────────────────────────────────────

describe('GET /admin/tasks/stats', () => {
    it('returns byStatus map and lastWeek count', async () => {
        const base = await getServer()
        enqueue(
            [{ status: 'complete', total: 10 }, { status: 'running', total: 2 }],
            [{ total: 7 }],
        )

        const res = await fetch(`${base}/admin/tasks/stats`)
        expect(res.status).toBe(200)
        const body = await res.json() as { byStatus: Record<string, number>; lastWeek: number }
        expect(body.byStatus).toMatchObject({ complete: 10, running: 2 })
        expect(body.lastWeek).toBe(7)
    })
})

// ── GET /health ────────────────────────────────────────────────────────────

describe('GET /admin/health', () => {
    it('returns status:ok with workspace, user, task and memory counts', async () => {
        const base = await getServer()
        enqueue(
            [{ ok: 1 }],            // db.execute SELECT 1
            [{ total: 3 }],         // wsCount
            [{ total: 12 }],        // userCount
            [{ total: 50 }],        // taskCount
            [{ total: 200 }],       // memCount
        )

        const res = await fetch(`${base}/admin/health`)
        expect(res.status).toBe(200)
        const body = await res.json() as {
            status: string
            counts: { workspaces: number; users: number; tasks: number; memoryEntries: number }
        }
        expect(body.status).toBe('ok')
        expect(body.counts.workspaces).toBe(3)
        expect(body.counts.users).toBe(12)
        expect(body.counts.tasks).toBe(50)
        expect(body.counts.memoryEntries).toBe(200)
    })

    it('returns 500 on DB failure', async () => {
        const base = await getServer()
        dbFail = true
        const res = await fetch(`${base}/admin/health`)
        expect(res.status).toBe(500)
    })
})

// ── GET /connections ───────────────────────────────────────────────────────

describe('GET /admin/connections', () => {
    it('returns connections list with total', async () => {
        const base = await getServer()
        enqueue([
            { id: 'c-1', type: 'github', name: 'GitHub', status: 'active', workspaceId: 'ws-1', createdAt: '2026-01-01T00:00:00Z' },
            { id: 'c-2', type: 'slack', name: 'Slack', status: 'active', workspaceId: 'ws-2', createdAt: '2026-01-01T00:00:00Z' },
        ])

        const res = await fetch(`${base}/admin/connections`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: unknown[]; total: number }
        expect(body.total).toBe(2)
        expect(body.items).toHaveLength(2)
    })
})

// ── GET /audit ─────────────────────────────────────────────────────────────

describe('GET /admin/audit', () => {
    it('returns audit log entries', async () => {
        const base = await getServer()
        enqueue([
            { id: 'a-1', userId: 'u-1', action: 'create', resource: 'task', resourceId: 't-1', metadata: null, createdAt: '2026-01-01T00:00:00Z' },
        ])

        const res = await fetch(`${base}/admin/audit`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: Array<{ action: string }>; total: number }
        expect(body.total).toBe(1)
        expect(body.items[0]!.action).toBe('create')
    })

    it('accepts a limit query param without erroring', async () => {
        const base = await getServer()
        enqueue([])

        const res = await fetch(`${base}/admin/audit?limit=10`)
        expect(res.status).toBe(200)
    })
})

// ── POST /workspaces ───────────────────────────────────────────────────────

describe('POST /admin/workspaces', () => {
    it('returns 400 when name is missing', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/admin/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ownerEmail: 'owner@example.com' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_NAME')
    })

    it('returns 201 with created workspace when name provided', async () => {
        const base = await getServer()
        const created = { id: 'ws-new', name: 'New Workspace', ownerId: 'admin-user-id', createdAt: '2026-01-01T00:00:00Z' }
        // No ownerEmail → no user lookup query; only the insert.returning query
        enqueue([created])

        const res = await fetch(`${base}/admin/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'New Workspace' }),
        })
        expect(res.status).toBe(201)
        const body = await res.json() as { id: string; name: string }
        expect(body.id).toBe('ws-new')
        expect(body.name).toBe('New Workspace')
    })

    it('uses admin user id as owner when no ownerEmail provided', async () => {
        const base = await getServer()
        const created = { id: 'ws-new', name: 'Admin WS', ownerId: 'admin-user-id', createdAt: '2026-01-01T00:00:00Z' }
        enqueue([created])

        const res = await fetch(`${base}/admin/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Admin WS' }),
        })
        expect(res.status).toBe(201)
        const body = await res.json() as { ownerId: string }
        expect(body.ownerId).toBe('admin-user-id')
    })

    it('returns 500 on DB failure', async () => {
        const base = await getServer()
        dbFail = true
        const res = await fetch(`${base}/admin/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Will Fail' }),
        })
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})
