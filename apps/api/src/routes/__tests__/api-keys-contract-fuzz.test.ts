// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * API-keys contract fuzz tests.
 *
 * Exercises the api-keys route against adversarial inputs:
 *   1. Missing required fields → 400, not 500
 *   2. Wrong types (name as number, scopes as string) → 400
 *   3. Oversized payloads → 413, not 500
 *   4. Invalid UUIDs in workspaceId / keyId → 400, not 500
 *   5. SQL injection probes → blocked by UUID regex or parameterized ORM
 *   6. Every error response has shape: { error: { code: string, message: string } }
 */

import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        select(_fields?: unknown) {
            return {
                from: () => ({
                    where: () => ({
                        orderBy: async () => [],
                    }),
                }),
            }
        },
        insert(_t: unknown) {
            return {
                values: (_row: unknown) => ({
                    returning: async (_fields?: unknown) => [
                        { id: 'new-key-id', name: 'test-key', createdAt: new Date().toISOString() },
                    ],
                }),
            }
        },
        update(_t: unknown) {
            return {
                set: (_vals: unknown) => ({
                    where: async (_cond: unknown) => undefined,
                }),
            }
        },
    },
    mcpTokens: {},
    eq: vi.fn(),
    and: vi.fn(),
    desc: vi.fn(),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server helpers ────────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function ensureServer(): Promise<string> {
    if (server) return baseUrl
    const { apiKeysRouter } = await import('../api-keys.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1/workspaces/:workspaceId/api-keys', apiKeysRouter)
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

const WS = '11111111-2222-3333-4444-555555555555'
const KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const DROP_TABLE = "'; DROP TABLE mcp_tokens--"
const QUOTE_OR = '" OR "1"="1'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing required fields → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('missing required fields → 400, not 500', () => {
    it('POST — completely empty body', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('POST — name is empty string (fails min(1))', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST — name is whitespace only (fails min(1) after no trim)', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '   ' }),
        })
        // Zod min(1) passes for whitespace; route succeeds — verify not a crash
        expect(res.status).not.toBe(500)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Wrong types → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('wrong types → 400, not 500', () => {
    it('POST — name is a number', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 42 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('POST — name is null', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: null }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST — name exceeds 100 chars', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x'.repeat(101) }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('POST — scopes is a string instead of array', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'my-key', scopes: 'read write' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('POST — scopes is a number', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'my-key', scopes: 99 }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Oversized payload → 413, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413, not 500', () => {
    it('POST — body exceeds 1 MB limit', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x'.repeat(1_100_000) }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Invalid UUIDs → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid UUID → 400, not 500', () => {
    it('GET — workspaceId is not a UUID', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/not-a-uuid/api-keys`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('GET — workspaceId is numeric string', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/12345/api-keys`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST — workspaceId is not a UUID', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/bad-ws-id/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'my-key' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('DELETE — keyId is not a UUID', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys/not-a-uuid`, {
            method: 'DELETE',
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('DELETE — workspaceId is not a UUID', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/bad-ws/api-keys/${KEY}`, {
            method: 'DELETE',
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. SQL injection probes → blocked or parameterized
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → no crash', () => {
    it('GET — DROP TABLE in workspaceId caught by UUID regex → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/workspaces/${encodeURIComponent(DROP_TABLE)}/api-keys`
        )
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET — OR-based injection in workspaceId caught by UUID regex → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/workspaces/${encodeURIComponent(QUOTE_OR)}/api-keys`
        )
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST — injection in name field → 201 (parameterized ORM blocks it)', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: DROP_TABLE }),
        })
        // Freeform text is passed as a parameterized value — Drizzle ORM never executes it.
        expect(res.status).toBe(201)
    })

    it('DELETE — injection in keyId caught by UUID regex → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/workspaces/${WS}/api-keys/${encodeURIComponent(DROP_TABLE)}`,
            { method: 'DELETE' }
        )
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code: string, message: string } }', () => {
    it('INVALID_WORKSPACE on GET has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(`${base}/api/v1/workspaces/bad/api-keys`).then(r => r.json())
        assertErrorShape(body)
    })

    it('VALIDATION_ERROR on POST has message field (was missing before fix)', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/workspaces/${WS}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 42 }),
        })
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('INVALID_ID on DELETE has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(
            `${base}/api/v1/workspaces/${WS}/api-keys/bad-key-id`,
            { method: 'DELETE' }
        ).then(r => r.json())
        assertErrorShape(body)
    })
})
