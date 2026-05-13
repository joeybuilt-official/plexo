// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cross-app token handoff route tests.
 *
 * Pins:
 *   1. POST /generate — 400 unknown/missing targetApp, 200 with 64-char hex token +
 *      correct redirectUrl shape, 30-second expiry
 *   2. POST /consume — 400 invalid token format, 401 expired/used/not-found token,
 *      200 returns userId + sourceApp
 */

// Set PUBLIC_URL before any module imports so KNOWN_APPS resolves 'plexo'
process.env.PUBLIC_URL = 'https://plexo.test'

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Test state ─────────────────────────────────────────────────────────────

const ctl = {
    userId: 'user-handoff-1',
    executeResult: [] as Array<Record<string, unknown>>,
    executeThrows: false,
}

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        execute: vi.fn(async () => {
            if (ctl.executeThrows) throw new Error('db error')
            return ctl.executeResult
        }),
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
        { join: vi.fn() },
    ),
}))

vi.mock('../../middleware/auth.js', () => ({
    requireAuth: vi.fn((req: any, _res: any, next: any) => {
        req.user = { id: ctl.userId, email: 'handoff@example.com' }
        next()
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
        const { handoffRouter } = await import('../handoff.js')
        const app = express()
        app.use(express.json())
        app.use('/api/auth/handoff', handoffRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((r) => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    ctl.userId = 'user-handoff-1'
    ctl.executeResult = []
    ctl.executeThrows = false
    process.env.PUBLIC_URL = 'https://plexo.test'
    vi.clearAllMocks()
})

afterAll(() => { server?.close() })

// ── POST /generate ─────────────────────────────────────────────────────────

describe('POST /api/auth/handoff/generate', () => {
    it('returns 400 when targetApp is missing', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_TARGET')
    })

    it('returns 400 for unknown targetApp', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: 'nonexistent_app' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string; message: string } }
        expect(body.error.code).toBe('INVALID_TARGET')
        expect(body.error.message).toContain('plexo')
    })

    it('returns token, redirectUrl, expiresAt on success', async () => {
        const base = await getServer()
        const before = Date.now()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: 'plexo' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { token: string; redirectUrl: string; expiresAt: string }
        expect(body.token).toMatch(/^[0-9a-f]{64}$/)
        expect(body.redirectUrl).toContain(body.token)
        expect(body.redirectUrl).toContain('from=plexo')
        // expiresAt is ~30 seconds from now
        const expiresMs = new Date(body.expiresAt).getTime()
        expect(expiresMs - before).toBeGreaterThan(25_000)
        expect(expiresMs - before).toBeLessThan(35_000)
    })

    it('token is exactly 64 hex characters', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: 'plexo' }),
        })
        expect(res.status).toBe(200)
        const { token } = await res.json() as { token: string }
        expect(token).toHaveLength(64)
        expect(token).toMatch(/^[0-9a-f]+$/)
    })

    it('redirectUrl points to the correct target app', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: 'plexo' }),
        })
        expect(res.status).toBe(200)
        const { redirectUrl } = await res.json() as { redirectUrl: string }
        expect(redirectUrl).toContain('/auth/handshake')
    })

    it('returns 500 when db.execute throws', async () => {
        ctl.executeThrows = true
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: 'plexo' }),
        })
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})

// ── POST /consume ──────────────────────────────────────────────────────────

const VALID_TOKEN = 'a'.repeat(64)

describe('POST /api/auth/handoff/consume', () => {
    it('returns 400 when token is missing', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_TOKEN')
    })

    it('returns 400 when token is wrong length (not 64 chars)', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'short_token' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_TOKEN')
    })

    it('returns 401 when token is not found / expired / already used', async () => {
        ctl.executeResult = [] // UPDATE returns 0 rows
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: VALID_TOKEN }),
        })
        expect(res.status).toBe(401)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('TOKEN_INVALID')
    })

    it('returns userId and sourceApp on success', async () => {
        ctl.executeResult = [{ user_id: 'user-abc-123', source_app: 'plexo', target_app: 'cc' }]
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: VALID_TOKEN }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { userId: string; sourceApp: string }
        expect(body.userId).toBe('user-abc-123')
        expect(body.sourceApp).toBe('plexo')
    })

    it('returns 500 when db.execute throws', async () => {
        ctl.executeThrows = true
        const base = await getServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: VALID_TOKEN }),
        })
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})
