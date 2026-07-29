// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Contract fuzz tests for the webhooks router.
 *
 * Verifies:
 *   1. Missing / empty bodies → handled gracefully (no 500)
 *   2. Oversized payloads → 413, not 500
 *   3. SQL injection in freeform fields → 201 (parameterized ORM)
 *   4. Invalid signature → 401 with structured error (not bare string)
 *   5. Queue failure → 500 with structured error (not bare string)
 *   6. Every error has shape: { error: { code: string, message: string } }
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createHmac } from 'node:crypto'

// ── Shared state ──────────────────────────────────────────────────────────────

const ctl = {
    workspaceExists: true,
    dbThrows: false,
    pushResult: 'task-fuzz-1',
    pushThrows: false,
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        select() {
            return {
                from(_t: unknown) { return this },
                where(_c: unknown) { return this },
                async limit(_n: number) {
                    if (ctl.dbThrows) throw new Error('DB error')
                    return ctl.workspaceExists ? [{ id: 'ws-fuzz' }] : []
                },
            }
        },
    },
    eq: vi.fn(),
    workspaces: { id: 'id' },
}))

vi.mock('@plexo/queue', () => ({
    push: vi.fn(async () => {
        if (ctl.pushThrows) throw new Error('Queue failure')
        return ctl.pushResult
    }),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server helpers ────────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function ensureServer() {
    if (server) return
    const { webhooksRouter } = await import('../webhooks.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1/webhooks', webhooksRouter)
    server = app.listen(0)
    await new Promise<void>(r => server!.once('listening', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(() => {
    ctl.workspaceExists = true
    ctl.dbThrows = false
    ctl.pushResult = 'task-fuzz-1'
    ctl.pushThrows = false
    delete process.env.PLEXO_WEBHOOK_SECRET
    vi.clearAllMocks()
})

afterAll(() => { server?.close() })

// ── Assertion helper ──────────────────────────────────────────────────────────

function assertErrorShape(body: unknown) {
    const b = body as any
    expect(b.error, 'error must be an object, not a bare string').toBeTypeOf('object')
    expect(b.error, 'error must not be null').not.toBeNull()
    expect(typeof b.error.code, 'error.code must be a string').toBe('string')
    expect(b.error.code.length, 'error.code must be non-empty').toBeGreaterThan(0)
    expect(typeof b.error.message, 'error.message must be a string').toBe('string')
    expect(b.error.message.length, 'error.message must be non-empty').toBeGreaterThan(0)
}

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const DROP_TABLE = "'; DROP TABLE webhooks--"
const OR_INJECTION = '" OR "1"="1'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Empty / minimal bodies → handled gracefully (all body fields optional)
// ─────────────────────────────────────────────────────────────────────────────

describe('empty and minimal bodies → handled gracefully', () => {
    it('POST completely empty body {} → 201 (body fields all optional)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(201)
        const body = await res.json() as any
        expect(body.taskId).toBe('task-fuzz-1')
        expect(body.status).toBe('queued')
    })

    it('POST with unknown extra fields → 201 (extra fields ignored)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unknownField: 42, nested: { x: true } }),
        })
        expect(res.status).toBe(201)
    })

    it('POST workspace not found → 404 with structured error', async () => {
        ctl.workspaceExists = false
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'test' }),
        })
        expect(res.status).toBe(404)
        assertErrorShape(await res.json())
    })

    it('POST DB throws on workspace lookup → 400 with structured error', async () => {
        ctl.dbThrows = true
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Oversized payload → 413, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413, not 500', () => {
    it('POST body exceeding 1 MB → 413', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'x'.repeat(1_200_000) }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. SQL injection probes → not a crash
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → not a crash', () => {
    it('injection in description (freeform) → 201 (Drizzle parameterized)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: DROP_TABLE }),
        })
        expect(res.status).toBe(201)
    })

    it('injection in message field → 201', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: OR_INJECTION }),
        })
        expect(res.status).toBe(201)
    })

    it('injection in text field → 201', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '/* injection */ 1=1' }),
        })
        expect(res.status).toBe(201)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. HMAC signature errors → 401 with structured { error: { code, message } }
//    (Previously returned bare-string errors — this suite pins the fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('HMAC auth errors → structured error shape (not bare string)', () => {
    it('missing X-Plexo-Signature when secret configured → 401 structured', async () => {
        process.env.PLEXO_WEBHOOK_SECRET = 'fuzz-secret'
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'unsigned' }),
        })
        expect(res.status).toBe(401)
        assertErrorShape(await res.json())
    })

    it('wrong X-Plexo-Signature value → 401 structured', async () => {
        process.env.PLEXO_WEBHOOK_SECRET = 'fuzz-secret'
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Plexo-Signature': 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            },
            body: JSON.stringify({ description: 'tampered' }),
        })
        expect(res.status).toBe(401)
        assertErrorShape(await res.json())
    })

    it('SQL injection in X-Plexo-Signature header → 401 structured (never crashes)', async () => {
        process.env.PLEXO_WEBHOOK_SECRET = 'fuzz-secret'
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Plexo-Signature': DROP_TABLE,
            },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(401)
        assertErrorShape(await res.json())
    })

    it('correct HMAC-SHA256 → 201 (control: valid sig still works)', async () => {
        const secret = 'fuzz-secret'
        process.env.PLEXO_WEBHOOK_SECRET = secret
        const payload = { description: 'signed' }
        const sig = 'sha256=' + createHmac('sha256', secret)
            .update(JSON.stringify(payload))
            .digest('hex')
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Plexo-Signature': sig },
            body: JSON.stringify(payload),
        })
        expect(res.status).toBe(201)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Queue failure → 500 with structured error (not bare string)
// ─────────────────────────────────────────────────────────────────────────────

describe('queue failure → structured 500', () => {
    it('push() throws → 500 with { error: { code, message } }', async () => {
        ctl.pushThrows = true
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'fail-me' }),
        })
        expect(res.status).toBe(500)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Error response shape: { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code, message } }', () => {
    it('404 not-found has structured error', async () => {
        ctl.workspaceExists = false
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        assertErrorShape(await res.json())
    })

    it('400 db-error has structured error', async () => {
        ctl.dbThrows = true
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        assertErrorShape(await res.json())
    })

    it('401 missing-signature has structured error', async () => {
        process.env.PLEXO_WEBHOOK_SECRET = 'fuzz-secret'
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        assertErrorShape(await res.json())
    })

    it('401 invalid-signature has structured error', async () => {
        process.env.PLEXO_WEBHOOK_SECRET = 'fuzz-secret'
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Plexo-Signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
            },
            body: '{}',
        })
        assertErrorShape(await res.json())
    })

    it('500 queue-failure has structured error', async () => {
        ctl.pushThrows = true
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/v1/webhooks/${WS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        assertErrorShape(await res.json())
    })
})
