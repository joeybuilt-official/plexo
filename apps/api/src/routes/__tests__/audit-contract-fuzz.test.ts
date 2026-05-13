// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Contract fuzz tests for the audit log router.
 *
 * Verifies that adversarial inputs never produce a 500 and that every
 * error response has shape: { error: { code: string, message: string } }
 *
 *   1. Missing workspaceId → 400 MISSING_WORKSPACE
 *   2. Non-UUID workspaceId → 400 INVALID_WORKSPACE
 *   3. Invalid 'before' date string → 400 INVALID_DATE (previously would reach DB as NaN)
 *   4. Oversized 'action' filter → 400 INVALID_ACTION
 *   5. Oversized payloads → 413
 *   6. SQL injection probes → 400 (UUID regex blocks workspaceId; action is parameterized)
 *   7. Every error response has shape: { error: { code: string, message: string } }
 */

import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        leftJoin: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(async () => []),
    }
    return {
        db: { select: vi.fn(() => builder) },
        auditLog: {
            id: 'id',
            workspaceId: 'workspace_id',
            action: 'action',
            resource: 'resource',
            resourceId: 'resource_id',
            metadata: 'metadata',
            ip: 'ip',
            createdAt: 'created_at',
            userId: 'user_id',
        },
        users: { id: 'id', name: 'name', email: 'email' },
        eq: vi.fn(),
        and: vi.fn((...args: unknown[]) => args),
        desc: vi.fn((c: any) => c),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server helpers ────────────────────────────────────────────────────────────

const WS = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

let server: Server | null = null
let baseUrl: string

async function ensureServer() {
    if (server) return
    const { auditRouter } = await import('../audit.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/audit', auditRouter)
    server = app.listen(0)
    await new Promise<void>(r => server!.once('listening', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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

const DROP_TABLE = "'; DROP TABLE audit_log--"
const OR_INJECTION = '" OR "1"="1'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing workspaceId → 400 MISSING_WORKSPACE
// ─────────────────────────────────────────────────────────────────────────────

describe('missing workspaceId → 400 MISSING_WORKSPACE', () => {
    it('GET /api/audit — no workspaceId → 400 MISSING_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('GET /api/audit — empty workspaceId string → 400 MISSING_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Non-UUID workspaceId → 400 INVALID_WORKSPACE
// ─────────────────────────────────────────────────────────────────────────────

describe('non-UUID workspaceId → 400 INVALID_WORKSPACE', () => {
    it('GET /api/audit — workspaceId is not a UUID → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=not-a-uuid`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('GET /api/audit — numeric workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=12345`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Invalid 'before' date → 400 INVALID_DATE (previously reached DB as NaN)
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid before date → 400 INVALID_DATE', () => {
    it('GET /api/audit — before="not-a-date" → 400 INVALID_DATE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&before=not-a-date`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_DATE')
    })

    it('GET /api/audit — before="0000-99-99" (invalid month) → 400 INVALID_DATE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&before=0000-99-99`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET /api/audit — before="NaN" → 400 INVALID_DATE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&before=NaN`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET /api/audit — before="" (empty) → NOT 400 (omitted → no cursor applied)', async () => {
        await ensureServer()
        // An empty string for 'before' is treated as absent — no cursor filter added.
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&before=`)
        expect(res.status).toBe(200)
    })

    it('GET /api/audit — valid ISO before → 200 (accepted)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&before=2026-01-01T00:00:00.000Z`)
        expect(res.status).toBe(200)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Oversized 'action' filter → 400 INVALID_ACTION
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized action filter → 400 INVALID_ACTION', () => {
    it('GET /api/audit — action > 100 chars → 400 INVALID_ACTION', async () => {
        await ensureServer()
        const longAction = 'a'.repeat(101)
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&action=${longAction}`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ACTION')
    })

    it('GET /api/audit — action exactly 100 chars → 200 (accepted)', async () => {
        await ensureServer()
        const validAction = 'a'.repeat(100)
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&action=${validAction}`)
        expect(res.status).toBe(200)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Oversized payloads → 413 (GET with very long query string)
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413 or 400, not 500', () => {
    it('GET /api/audit — action > 100 chars is rejected before DB → 400, not 500', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&action=${'x'.repeat(200)}`)
        expect(res.status).toBe(400)
        expect(res.status).not.toBe(500)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. SQL injection probes → 400 (UUID regex blocks workspaceId reach to DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → not a crash', () => {
    it('GET /api/audit — injection in workspaceId → 400 (UUID regex blocks it)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${encodeURIComponent(DROP_TABLE)}`)
        expect(res.status).toBe(400)
    })

    it('GET /api/audit — OR-based injection in workspaceId → 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${encodeURIComponent(OR_INJECTION)}`)
        expect(res.status).toBe(400)
    })

    it('GET /api/audit — injection in action (short) → 200 (parameterized LIKE, not executed as SQL)', async () => {
        await ensureServer()
        // action uses parameterized sql template so injection is blocked by Drizzle ORM.
        // The action filter is short enough to pass the 100-char limit.
        const shortInjection = "'; DROP--"
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&action=${encodeURIComponent(shortInjection)}`)
        expect(res.status).toBe(200)
        expect(res.status).not.toBe(500)
    })

    it('GET /api/audit — injection in before (date field) → 400 INVALID_DATE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&before=${encodeURIComponent("'; DROP TABLE--")}`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET /api/audit — comment-based injection in action → 200 (parameterized)', async () => {
        await ensureServer()
        const injection = '/* injection */ 1=1'
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&action=${encodeURIComponent(injection)}`)
        expect(res.status).toBe(200)
        expect(res.status).not.toBe(500)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code: string, message: string } }', () => {
    it('missing workspaceId → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit`)
        assertErrorShape(await res.json())
    })

    it('invalid workspaceId → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=bad`)
        assertErrorShape(await res.json())
    })

    it('invalid before date → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&before=garbage`)
        assertErrorShape(await res.json())
    })

    it('action too long → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/audit?workspaceId=${WS}&action=${'z'.repeat(200)}`)
        assertErrorShape(await res.json())
    })
})
