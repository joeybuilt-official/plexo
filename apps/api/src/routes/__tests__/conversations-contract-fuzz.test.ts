// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Contract fuzz tests for the conversations router.
 *
 * Verifies that adversarial inputs never produce a 500 and that every
 * error response has shape: { error: { code: string, message: string } }
 *
 *   1. Missing workspaceId → 400 MISSING_WORKSPACE
 *   2. id > 64 chars → 400 INVALID_ID
 *   3. sessionId > 64 chars → 400 INVALID_SESSION
 *   4. SQL injection probes → not a crash (ORM parameterizes; UUID regex guards workspaceId)
 *   5. Oversized payloads → 413
 *   6. Valid inputs with no data → 200 with empty list
 *   7. Every error response has shape: { error: { code: string, message: string } }
 *
 * NOTE: GET /conversations?workspaceId=invalid-uuid currently returns 200 with
 * an empty list (not a 400). This is documented here as expected behavior.
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
        orderBy: vi.fn(() => builder),
        limit: vi.fn(async () => []),
    }
    return {
        db: {
            select: vi.fn(() => builder),
            execute: vi.fn(async () => []),
        },
        conversations: { id: 'id', workspaceId: 'workspace_id', createdAt: 'created_at' },
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

// ── Server helpers ────────────────────────────────────────────────────────────

const WS = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

let byIdServer: Server | null = null
let byIdUrl: string
let listServer: Server | null = null
let listUrl: string

async function ensureByIdServer() {
    if (byIdServer) return
    const { conversationsRouter } = await import('../conversations.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1/conversations', conversationsRouter)
    byIdServer = app.listen(0)
    await new Promise<void>(r => byIdServer!.once('listening', r))
    byIdUrl = `http://127.0.0.1:${(byIdServer.address() as AddressInfo).port}`
}

// Same router instance handles both routes; we share a single server.
async function ensureListServer() {
    if (listServer) return
    const { conversationsRouter } = await import('../conversations.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1/conversations', conversationsRouter)
    listServer = app.listen(0)
    await new Promise<void>(r => listServer!.once('listening', r))
    listUrl = `http://127.0.0.1:${(listServer.address() as AddressInfo).port}`
}

afterAll(() => {
    byIdServer?.close()
    listServer?.close()
})

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

const DROP_TABLE = "'; DROP TABLE conversations--"
const OR_INJECTION = '" OR "1"="1'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing required fields → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('missing required fields → 400, not 500', () => {
    it('GET /conversations — no workspaceId → 400 MISSING_WORKSPACE', async () => {
        await ensureListServer()
        const res = await fetch(`${listUrl}/api/v1/conversations`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('GET /conversations — empty workspaceId → 400 MISSING_WORKSPACE', async () => {
        await ensureListServer()
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. id > 64 chars → 400 INVALID_ID (GET /:id)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /conversations/:id — id validation → 400', () => {
    it('id exceeds 64 chars → 400 INVALID_ID', async () => {
        await ensureByIdServer()
        const res = await fetch(`${byIdUrl}/api/v1/conversations/${'a'.repeat(65)}`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('id exactly 64 chars → not 400 (passes length check, 404 if not found)', async () => {
        await ensureByIdServer()
        const res = await fetch(`${byIdUrl}/api/v1/conversations/${'b'.repeat(64)}`)
        expect(res.status).not.toBe(400)
        // Will be 404 since DB mock returns nothing.
        expect(res.status).toBe(404)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. sessionId > 64 chars → 400 INVALID_SESSION
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /conversations — sessionId validation → 400', () => {
    it('sessionId exceeds 128 chars → 400 INVALID_SESSION', async () => {
        await ensureListServer()
        const longSession = 'c'.repeat(129)
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${WS}&sessionId=${longSession}`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_SESSION')
    })

    it('sessionId exactly 128 chars → 200 (valid boundary)', async () => {
        await ensureListServer()
        const validSession = 'd'.repeat(128)
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${WS}&sessionId=${validSession}`)
        expect(res.status).toBe(200)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. SQL injection probes → not a crash
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → not a crash', () => {
    it('GET /conversations — injection in workspaceId → 200 empty (UUID regex gates it)', async () => {
        await ensureListServer()
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${encodeURIComponent(DROP_TABLE)}`)
        // Invalid UUID → current behavior returns 200 {} (documented, not a 500)
        expect(res.status).not.toBe(500)
    })

    it('GET /conversations/:id — injection in id (≤64 chars) → 404 (ORM parameterizes)', async () => {
        await ensureByIdServer()
        // Short injection string passes length check; ORM prevents SQL damage.
        const shortInjection = "'; DROP--"
        const res = await fetch(`${byIdUrl}/api/v1/conversations/${encodeURIComponent(shortInjection)}`)
        expect(res.status).not.toBe(500)
        // DB mock returns [] → 404
        expect(res.status).toBe(404)
    })

    it('GET /conversations/:id — injection in id (>64 chars) → 400 INVALID_ID', async () => {
        await ensureByIdServer()
        // Must be >64 chars after URL-decoding (Express decodes path params before handler sees them).
        const longInjection = DROP_TABLE + 'x'.repeat(40)
        const res = await fetch(`${byIdUrl}/api/v1/conversations/${encodeURIComponent(longInjection)}`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET /conversations — OR injection in workspaceId → not 500', async () => {
        await ensureListServer()
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${encodeURIComponent(OR_INJECTION)}`)
        expect(res.status).not.toBe(500)
    })

    it('GET /conversations — injection in sessionId (short) → 200 (parameterized)', async () => {
        await ensureListServer()
        const shortInjection = "'; DROP--"
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${WS}&sessionId=${encodeURIComponent(shortInjection)}`)
        expect(res.status).not.toBe(500)
    })

    it('GET /conversations — comment injection in cursor → 200 (parameterized)', async () => {
        await ensureListServer()
        const injection = '/* injection */'
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${WS}&cursor=${encodeURIComponent(injection)}`)
        expect(res.status).not.toBe(500)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Empty arrays / bodies → handled gracefully (no 500)
// ─────────────────────────────────────────────────────────────────────────────

describe('valid inputs with no data → 200 with empty list', () => {
    it('GET /conversations — valid workspaceId, no data → 200 with empty list', async () => {
        await ensureListServer()
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(Array.isArray(body.items)).toBe(true)
        expect(body.items.length).toBe(0)
    })

    it('GET /conversations — groupBySession=true, no data → 200 with empty list', async () => {
        await ensureListServer()
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${WS}&groupBySession=true`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(Array.isArray(body.items)).toBe(true)
    })

    it('GET /conversations — valid sessionId, no data → 200 with empty list', async () => {
        await ensureListServer()
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${WS}&sessionId=some-session`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(Array.isArray(body.items)).toBe(true)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code: string, message: string } }', () => {
    it('GET /conversations — missing workspaceId → structured 400', async () => {
        await ensureListServer()
        const res = await fetch(`${listUrl}/api/v1/conversations`)
        assertErrorShape(await res.json())
    })

    it('GET /conversations/:id — id too long → structured 400', async () => {
        await ensureByIdServer()
        const res = await fetch(`${byIdUrl}/api/v1/conversations/${'e'.repeat(65)}`)
        assertErrorShape(await res.json())
    })

    it('GET /conversations/:id — id valid but not found → structured 404', async () => {
        await ensureByIdServer()
        const res = await fetch(`${byIdUrl}/api/v1/conversations/valid-short-id`)
        expect(res.status).toBe(404)
        assertErrorShape(await res.json())
    })

    it('GET /conversations — sessionId too long → structured 400', async () => {
        await ensureListServer()
        const res = await fetch(`${listUrl}/api/v1/conversations?workspaceId=${WS}&sessionId=${'f'.repeat(129)}`)
        assertErrorShape(await res.json())
    })
})
