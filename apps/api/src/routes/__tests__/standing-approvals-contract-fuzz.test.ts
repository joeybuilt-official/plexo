// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Standing-approvals contract fuzz tests.
 *
 * Exercises the standing-approvals route against adversarial inputs:
 *   1. Missing required fields → 400, not 500
 *   2. Invalid UUIDs in workspaceId / id → 400, not 500
 *   3. Oversized payloads → 413, not 500
 *   4. SQL injection probes → blocked by UUID regex or parameterized ORM
 *   5. Every error response has shape: { error: { code: string, message: string } }
 *
 * Functional tests in standing-approvals.test.ts cover happy paths.
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
                    where: async () => [],
                }),
            }
        },
        insert(_t: unknown) {
            return {
                values: (_row: unknown) => ({
                    returning: async () => [
                        {
                            id: 'inserted-id',
                            workspaceId: '11111111-2222-3333-4444-555555555555',
                            trigger: 'test-trigger',
                            actionPattern: 'test-action',
                        },
                    ],
                }),
            }
        },
        delete(_t: unknown) {
            return {
                where: () => ({
                    returning: async () => [],
                }),
            }
        },
    },
    standingApprovals: {},
    eq: vi.fn(),
    and: vi.fn(),
}))

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server helpers ────────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function ensureServer(): Promise<string> {
    if (server) return baseUrl
    const { standingApprovalsRouter } = await import('../standing-approvals.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1/standing-approvals', standingApprovalsRouter)
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
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const DROP_TABLE = "'; DROP TABLE standing_approvals--"
const QUOTE_OR = '" OR "1"="1'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing required fields → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('missing required fields → 400, not 500', () => {
    it('GET — no workspaceId query param', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('GET — empty workspaceId string', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals?workspaceId=`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST — no workspaceId in body', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'deploy', actionPattern: 'push*' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('POST — no trigger field', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, actionPattern: 'push*' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_PARAMS')
    })

    it('POST — no actionPattern field', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, trigger: 'deploy' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_PARAMS')
    })

    it('POST — completely empty body', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('DELETE — no workspaceId query param', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals/${ID}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Invalid UUIDs → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid UUID → 400, not 500', () => {
    it('GET — workspaceId is not a UUID', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals?workspaceId=not-a-uuid`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('GET — workspaceId is numeric string', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals?workspaceId=12345`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST — workspaceId is not a UUID', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'bad-ws', trigger: 'deploy', actionPattern: '*' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('DELETE — id is not a UUID', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/standing-approvals/not-a-uuid?workspaceId=${WS}`,
            { method: 'DELETE' }
        )
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('DELETE — id too short', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/standing-approvals/short?workspaceId=${WS}`,
            { method: 'DELETE' }
        )
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
        const res = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceId: WS,
                trigger: 'deploy',
                actionPattern: 'x'.repeat(1_100_000),
            }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. SQL injection probes → blocked or parameterized
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → no crash', () => {
    it('GET — DROP TABLE in workspaceId caught by UUID regex → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/standing-approvals?workspaceId=${encodeURIComponent(DROP_TABLE)}`
        )
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET — OR-based injection in workspaceId caught by UUID regex → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/standing-approvals?workspaceId=${encodeURIComponent(QUOTE_OR)}`
        )
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST — injection in trigger field → 201 (parameterized ORM blocks it)', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceId: WS,
                trigger: DROP_TABLE,
                actionPattern: 'push/*',
            }),
        })
        // Trigger is a freeform field passed as a bind variable — never executed as SQL.
        expect(res.status).toBe(201)
    })

    it('POST — injection in actionPattern field → 201 (parameterized ORM blocks it)', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceId: WS,
                trigger: 'deploy',
                actionPattern: QUOTE_OR,
            }),
        })
        expect(res.status).toBe(201)
    })

    it('POST — injection in workspaceId caught by UUID regex → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceId: DROP_TABLE,
                trigger: 'deploy',
                actionPattern: 'push/*',
            }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('DELETE — injection in id caught by UUID regex → 400', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/standing-approvals/${encodeURIComponent(DROP_TABLE)}?workspaceId=${WS}`,
            { method: 'DELETE' }
        )
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code: string, message: string } }', () => {
    it('MISSING_WORKSPACE on GET has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(`${base}/api/v1/standing-approvals`).then(r => r.json())
        assertErrorShape(body)
    })

    it('INVALID_PARAMS on POST has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(`${base}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        }).then(r => r.json())
        assertErrorShape(body)
    })

    it('INVALID_ID on DELETE has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(
            `${base}/api/v1/standing-approvals/bad-id?workspaceId=${WS}`,
            { method: 'DELETE' }
        ).then(r => r.json())
        assertErrorShape(body)
    })
})
