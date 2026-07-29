// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Contract fuzz tests for the clarification router.
 *
 * Verifies that adversarial inputs never produce a 500 and that every
 * error response has shape: { error: { code: string, message: string } }
 *
 *   1. Missing / invalid taskId → 400, not 500
 *   2. Wrong types (alternativeIndex as string/float/negative) → 400
 *   3. Oversized payload → 413
 *   4. Invalid taskId length (> 64 chars) → 400
 *   5. Task not found → 404 with structured error
 *   6. SQL injection probes in taskId → 400 (length guard or safe through ORM)
 *   7. Every error response has shape: { error: { code: string, message: string } }
 */

import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Shared control ────────────────────────────────────────────────────────────

const ctl = {
    taskRow: null as Record<string, unknown> | null,
    newTaskId: 'new-task-id',
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => ctl.taskRow ? [ctl.taskRow] : []),
    }
    return {
        db: { select: vi.fn(() => builder) },
        tasks: { id: 'id', context: 'context', status: 'status', workspaceId: 'workspace_id', type: 'type' },
        eq: vi.fn(),
    }
})

vi.mock('@plexo/queue', () => ({
    push: vi.fn(async () => ctl.newTaskId),
}))

vi.mock('../../event-tracker.js', () => ({ trackEvent: vi.fn() }))
vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server helpers ────────────────────────────────────────────────────────────

const TASK_ID = 'task-id-0123456789'

let server: Server | null = null
let baseUrl: string

async function ensureServer() {
    if (server) return
    const { clarificationRouter } = await import('../clarification.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    // Mount with mergeParams so :taskId from the parent route is propagated.
    app.use('/api/v1/tasks/:taskId/clarification', clarificationRouter)
    server = app.listen(0)
    await new Promise<void>(r => server!.once('listening', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(() => { ctl.taskRow = null })
afterAll(() => { server?.close() })

// ── Assertion helper ──────────────────────────────────────────────────────────

function assertErrorShape(body: unknown) {
    const b = body as any
    expect(b.error, 'error must be an object').toBeTypeOf('object')
    expect(b.error, 'error must not be null').not.toBeNull()
    expect(typeof b.error.code, 'error.code must be a string').toBe('string')
    expect(b.error.code.length, 'error.code must be non-empty').toBeGreaterThan(0)
    expect(typeof b.error.message, 'error.message must be a string').toBe('string')
    expect(b.error.message.length, 'error.message must be non-empty').toBeGreaterThan(0)
}

const DROP_TABLE = "'; DROP TABLE tasks--"

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing / invalid taskId → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid taskId → 400, not 500', () => {
    it('GET clarification — taskId exceeds 64 chars → 400 INVALID_TASK', async () => {
        await ensureServer()
        const longId = 'a'.repeat(65)
        const res = await fetch(`${baseUrl}/api/v1/tasks/${longId}/clarification`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_TASK')
    })

    it('POST /respond — taskId exceeds 64 chars → 400 INVALID_TASK', async () => {
        await ensureServer()
        const longId = 'b'.repeat(65)
        const res = await fetch(`${baseUrl}/api/v1/tasks/${longId}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alternativeIndex: 0 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_TASK')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Wrong types for alternativeIndex → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('wrong types for alternativeIndex → 400', () => {
    it('POST /respond — alternativeIndex is a string → 400 INVALID_INDEX', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alternativeIndex: 'first' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_INDEX')
    })

    it('POST /respond — alternativeIndex is negative → 400 INVALID_INDEX', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alternativeIndex: -1 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_INDEX')
    })

    it('POST /respond — alternativeIndex is a float → 400 INVALID_INDEX', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alternativeIndex: 1.5 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_INDEX')
    })

    it('POST /respond — alternativeIndex is boolean → 400 INVALID_INDEX', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alternativeIndex: true }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Oversized payload → 413
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413, not 500', () => {
    it('POST /respond — body exceeds 1 MB → 413', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alternativeIndex: 0, junk: 'x'.repeat(1_200_000) }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Task not found → 404 with structured error
// ─────────────────────────────────────────────────────────────────────────────

describe('task not found → 404 with structured error', () => {
    it('GET clarification — task does not exist → 404 NOT_FOUND', async () => {
        await ensureServer()
        ctl.taskRow = null
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification`)
        expect(res.status).toBe(404)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('NOT_FOUND')
    })

    it('POST /respond — task does not exist → 404 NOT_FOUND', async () => {
        await ensureServer()
        ctl.taskRow = null
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(404)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('NOT_FOUND')
    })

    it('GET clarification — task exists but no clarification payload → 404 NO_CLARIFICATION', async () => {
        await ensureServer()
        ctl.taskRow = { context: {}, status: 'running', workspaceId: 'ws-1', type: 'coding' }
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification`)
        expect(res.status).toBe(404)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('NO_CLARIFICATION')
    })

    it('POST /respond — task has no clarification payload → 400 NO_CLARIFICATION', async () => {
        await ensureServer()
        ctl.taskRow = { context: {}, status: 'running', workspaceId: 'ws-1', type: 'coding' }
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('NO_CLARIFICATION')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Index out of range → 400 with structured error
// ─────────────────────────────────────────────────────────────────────────────

describe('alternativeIndex out of range → 400', () => {
    it('POST /respond — index beyond array bounds → 400 INDEX_OUT_OF_RANGE', async () => {
        await ensureServer()
        ctl.taskRow = {
            context: { _clarification: { alternatives: [{ label: 'a', taskDescription: 'd' }] } },
            status: 'blocked',
            workspaceId: 'ws-1',
            type: 'coding',
        }
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alternativeIndex: 99 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INDEX_OUT_OF_RANGE')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. SQL injection probes → not a crash
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → not a crash', () => {
    it('GET clarification — injection in taskId (<=64 chars) → 404 (ORM parameterizes)', async () => {
        await ensureServer()
        ctl.taskRow = null
        // The injection string is short enough to pass the length check.
        // Drizzle ORM uses parameterized queries so it cannot cause DB damage.
        const shortInjection = "'; DROP--"
        const res = await fetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(shortInjection)}/clarification`)
        // Length ≤ 64 passes validation; DB mock returns [] → 404
        expect(res.status).not.toBe(500)
    })

    it('GET clarification — long injection string (>64 chars) → 400 INVALID_TASK', async () => {
        await ensureServer()
        // Must be >64 chars after URL-decoding (Express decodes path params before handler sees them).
        const longInjection = encodeURIComponent(DROP_TABLE + 'x'.repeat(50))
        const res = await fetch(`${baseUrl}/api/v1/tasks/${longInjection}/clarification`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /respond — injection in body (valid alternativeIndex) → not 500', async () => {
        await ensureServer()
        ctl.taskRow = null
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alternativeIndex: 0, comment: DROP_TABLE }),
        })
        // comment is ignored; task not found → 404
        expect(res.status).not.toBe(500)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code: string, message: string } }', () => {
    it('GET — taskId too long → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/tasks/${'x'.repeat(65)}/clarification`)
        assertErrorShape(await res.json())
    })

    it('GET — task not found → structured 404', async () => {
        await ensureServer()
        ctl.taskRow = null
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification`)
        assertErrorShape(await res.json())
    })

    it('POST /respond — taskId too long → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/tasks/${'y'.repeat(65)}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        assertErrorShape(await res.json())
    })

    it('POST /respond — invalid alternativeIndex type → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alternativeIndex: 'bad' }),
        })
        assertErrorShape(await res.json())
    })

    it('POST /respond — task not found → structured 404', async () => {
        await ensureServer()
        ctl.taskRow = null
        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/clarification/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        assertErrorShape(await res.json())
    })
})
