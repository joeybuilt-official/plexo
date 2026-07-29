// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Webhook route tests.
 *
 * Pins:
 *   1. POST /:workspaceId workspace validation — 404 unknown workspace, 400 db-throws
 *   2. POST /:workspaceId HMAC signature — 201 no-secret, 401 missing-header,
 *      401 wrong-sig, 201 correct HMAC-SHA256
 *   3. POST /:workspaceId task creation — description priority fallback,
 *      201 taskId returned, 500 queue-failure
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createHmac } from 'node:crypto'

// ── Test state ─────────────────────────────────────────────────────────────

const ctl = {
    workspaceExists: true,
    dbThrows: false,
    pushResult: 'task-abc',
    pushThrows: false,
    lastPushArgs: null as Record<string, unknown> | null,
}

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        select(_fields?: unknown) {
            return {
                from(_t: unknown) { return this },
                where(_c: unknown) { return this },
                async limit(_n: number) {
                    if (ctl.dbThrows) throw new Error('DB connection error')
                    return ctl.workspaceExists ? [{ id: 'ws-123' }] : []
                },
            }
        },
    },
    eq: vi.fn(),
    workspaces: { id: 'workspaces.id' },
}))

vi.mock('@plexo/queue', () => ({
    push: vi.fn(async (args: Record<string, unknown>) => {
        ctl.lastPushArgs = args
        if (ctl.pushThrows) throw new Error('Queue unavailable')
        return ctl.pushResult
    }),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server bootstrap ───────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const { webhooksRouter } = await import('../webhooks.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/webhooks', webhooksRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>(r => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    ctl.workspaceExists = true
    ctl.dbThrows = false
    ctl.pushResult = 'task-abc'
    ctl.pushThrows = false
    ctl.lastPushArgs = null
    delete process.env.PLEXO_WEBHOOK_SECRET
    vi.clearAllMocks()
})

afterAll(() => { server?.close() })

// ── Workspace validation ───────────────────────────────────────────────────

describe('POST /api/v1/webhooks/:workspaceId — workspace validation', () => {
    it('returns 404 when workspace does not exist', async () => {
        ctl.workspaceExists = false
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/webhooks/nonexistent-ws`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'test' }),
        })
        expect(res.status).toBe(404)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('NOT_FOUND')
    })

    it('returns 400 when the DB throws on workspace lookup', async () => {
        ctl.dbThrows = true
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/webhooks/bad-id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_ID')
    })
})

// ── HMAC signature verification ────────────────────────────────────────────

describe('POST /api/v1/webhooks/:workspaceId — HMAC signature', () => {
    it('returns 201 without requiring a signature when PLEXO_WEBHOOK_SECRET is not set', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/webhooks/ws-123`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'no-sig-needed' }),
        })
        expect(res.status).toBe(201)
    })

    it('returns 401 when secret is configured but X-Plexo-Signature header is absent', async () => {
        process.env.PLEXO_WEBHOOK_SECRET = 'test-secret'
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/webhooks/ws-123`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'unsigned' }),
        })
        expect(res.status).toBe(401)
        const body = await res.json() as { error: { code: string; message: string } }
        expect(body.error.code).toBe('MISSING_SIGNATURE')
        expect(body.error.message).toMatch(/signature/i)
    })

    it('returns 401 when X-Plexo-Signature does not match body HMAC', async () => {
        process.env.PLEXO_WEBHOOK_SECRET = 'test-secret'
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/webhooks/ws-123`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Plexo-Signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
            },
            body: JSON.stringify({ description: 'tampered payload' }),
        })
        expect(res.status).toBe(401)
        const body = await res.json() as { error: { code: string; message: string } }
        expect(body.error.code).toBe('INVALID_SIGNATURE')
        expect(body.error.message).toMatch(/Invalid signature/i)
    })

    it('returns 201 when X-Plexo-Signature matches HMAC-SHA256 of JSON body', async () => {
        const secret = 'test-secret'
        process.env.PLEXO_WEBHOOK_SECRET = secret
        const payload = { description: 'signed payload', type: 'alert' }
        const sig = 'sha256=' + createHmac('sha256', secret)
            .update(JSON.stringify(payload))
            .digest('hex')
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/webhooks/ws-123`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Plexo-Signature': sig,
            },
            body: JSON.stringify(payload),
        })
        expect(res.status).toBe(201)
        const body = await res.json() as { taskId: string; status: string }
        expect(body.taskId).toBe('task-abc')
        expect(body.status).toBe('queued')
    })
})

// ── Task creation & description fallback ──────────────────────────────────

describe('POST /api/v1/webhooks/:workspaceId — task creation', () => {
    it('passes body.description as the task description when present', async () => {
        const base = await getServer()
        await fetch(`${base}/api/v1/webhooks/ws-123`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'explicit description' }),
        })
        expect(ctl.lastPushArgs).toMatchObject({
            context: expect.objectContaining({ description: 'explicit description' }),
        })
    })

    it('falls back to body.message when body.description is absent', async () => {
        const base = await getServer()
        await fetch(`${base}/api/v1/webhooks/ws-123`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'from message field' }),
        })
        expect(ctl.lastPushArgs).toMatchObject({
            context: expect.objectContaining({ description: 'from message field' }),
        })
    })

    it('falls back to body.text when neither description nor message is present', async () => {
        const base = await getServer()
        await fetch(`${base}/api/v1/webhooks/ws-123`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'from text field' }),
        })
        expect(ctl.lastPushArgs).toMatchObject({
            context: expect.objectContaining({ description: 'from text field' }),
        })
    })

    it('falls back to default description when body has no text fields', async () => {
        const base = await getServer()
        await fetch(`${base}/api/v1/webhooks/ws-123`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ someOtherField: 42 }),
        })
        expect(ctl.lastPushArgs).toMatchObject({
            context: expect.objectContaining({ description: 'Webhook-triggered task' }),
        })
    })

    it('returns 500 when the queue push throws', async () => {
        ctl.pushThrows = true
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/webhooks/ws-123`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'test' }),
        })
        expect(res.status).toBe(500)
    })
})
