// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Handoff contract fuzz tests.
 *
 * Exercises cross-app handoff routes against adversarial inputs:
 *   1. Wrong types for targetApp and token → 400, not 500
 *   2. Oversized payloads → 413, not 500
 *   3. SQL injection probes → blocked by enum/length guards
 *   4. Every error response has shape: { error: { code: string, message: string } }
 *
 * The functional tests in handoff.test.ts cover the happy paths.
 * This file adds adversarial coverage on top.
 */

import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Test state ────────────────────────────────────────────────────────────────

const ctl = {
    userId: 'fuzz-user-1',
    executeResult: [] as Array<Record<string, unknown>>,
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        execute: vi.fn(async () => ctl.executeResult),
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
        { join: vi.fn() },
    ),
}))

vi.mock('../../middleware/auth.js', () => ({
    requireAuth: vi.fn((req: any, _res: any, next: any) => {
        req.user = { id: ctl.userId, email: 'fuzz@example.com' }
        next()
    }),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server helpers ────────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function ensureServer(): Promise<string> {
    if (server) return baseUrl
    const { handoffRouter } = await import('../handoff.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/auth/handoff', handoffRouter)
    server = app.listen(0)
    await new Promise<void>(r => server!.once('listening', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return baseUrl
}

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

const DROP_TABLE = "'; DROP TABLE cross_app_tokens--"

// ─────────────────────────────────────────────────────────────────────────────
// 1. Wrong types → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('wrong types → 400, not 500', () => {
    it('POST /generate — targetApp is a number', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: 42 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_TARGET')
    })

    it('POST /generate — targetApp is an array', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: ['cc'] }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /generate — targetApp is null', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: null }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /consume — token is a number', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 12345678901234567890 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_TOKEN')
    })

    it('POST /consume — token is an object', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: { value: 'abc' } }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /consume — token is 63 chars (one short)', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'a'.repeat(63) }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_TOKEN')
    })

    it('POST /consume — token is 65 chars (one over)', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'a'.repeat(65) }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Oversized payload → 413, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413, not 500', () => {
    it('POST /generate — body exceeds 1 MB limit', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: 'x'.repeat(1_100_000) }),
        })
        expect(res.status).toBe(413)
    })

    it('POST /consume — body exceeds 1 MB limit', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'x'.repeat(1_100_000) }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. SQL injection probes → blocked by enum / length guards
// ─────────────────────────────────────────────────────────────────injected────────
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → no crash', () => {
    it('POST /generate — DROP TABLE in targetApp caught by KNOWN_APPS lookup → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: DROP_TABLE }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /generate — OR-based injection in targetApp → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: '" OR "1"="1' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /consume — injection in token (< 64 chars) caught by length check → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: DROP_TABLE }),
        })
        // DROP_TABLE is shorter than 64 chars — caught by length guard.
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /consume — 64-char injection string → 401 (DB finds no matching token)', async () => {
        ctl.executeResult = [] // DB returns no rows → TOKEN_INVALID
        const base = await ensureServer()
        // Build exactly 64 chars with SQL-like characters — passes length check.
        const injectionToken = ("'; UPDATE cross_app_tokens SET used=false WHERE '1'='").padEnd(64, '1')
        expect(injectionToken).toHaveLength(64)
        const res = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: injectionToken }),
        })
        // Parameterized query — token is a bind variable, never executed as SQL.
        // DB returns no matching row → 401, not 500.
        expect(res.status).toBe(401)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code: string, message: string } }', () => {
    it('INVALID_TARGET has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(`${base}/api/auth/handoff/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetApp: 'unknown_app' }),
        }).then(r => r.json())
        assertErrorShape(body)
    })

    it('INVALID_TOKEN has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'short' }),
        }).then(r => r.json())
        assertErrorShape(body)
    })

    it('TOKEN_INVALID has message field', async () => {
        ctl.executeResult = []
        const base = await ensureServer()
        const body = await fetch(`${base}/api/auth/handoff/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'b'.repeat(64) }),
        }).then(r => r.json())
        assertErrorShape(body)
    })
})
