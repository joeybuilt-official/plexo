// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * API-keys route tests.
 *
 * Pins:
 *   1. GET / — 400 on missing/invalid workspaceId UUID; 200 with items array on success
 *   2. POST / — 400 on invalid workspaceId; 400 on missing/invalid body;
 *      201 with `plx_`-prefixed token on success; token NOT stored in response id
 *   3. DELETE /:keyId — 400 on invalid UUID params; 200 { ok: true } on success;
 *      500 on DB failure
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Test state ─────────────────────────────────────────────────────────────

const ctl = {
    selectRows: [] as unknown[],
    insertedRow: null as null | { id: string; name: string; createdAt: string },
    dbThrows: false,
}

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        select(_fields?: unknown) {
            return {
                from: () => ({
                    where: () => ({
                        orderBy: async () => {
                            if (ctl.dbThrows) throw new Error('DB error')
                            return ctl.selectRows
                        },
                    }),
                }),
            }
        },
        insert(_t: unknown) {
            return {
                values: (_row: unknown) => ({
                    returning: async (_fields?: unknown) => {
                        if (ctl.dbThrows) throw new Error('DB error')
                        return ctl.insertedRow ? [ctl.insertedRow] : []
                    },
                }),
            }
        },
        update(_t: unknown) {
            return {
                set: (_vals: unknown) => ({
                    where: async (_cond: unknown) => {
                        if (ctl.dbThrows) throw new Error('DB error')
                    },
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

// ── Test harness ───────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

const WORKSPACE_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const KEY_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'

beforeEach(async () => {
    ctl.selectRows = []
    ctl.insertedRow = null
    ctl.dbThrows = false
    vi.clearAllMocks()

    if (!server) {
        const { apiKeysRouter } = await import('../api-keys.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/workspaces/:workspaceId/api-keys', apiKeysRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

// ── GET / ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/workspaces/:workspaceId/api-keys', () => {
    it('returns 400 when workspaceId is missing (empty string in path)', async () => {
        // Route won't even match without a segment — use a malformed UUID instead
        const res = await fetch(`${baseUrl}/api/v1/workspaces/not-a-uuid/api-keys`)
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('returns 400 when workspaceId is not a valid UUID', async () => {
        const res = await fetch(`${baseUrl}/api/v1/workspaces/12345/api-keys`)
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('returns 200 with empty items when no keys exist', async () => {
        ctl.selectRows = []
        const res = await fetch(`${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: unknown[]; total: number }
        expect(body.items).toHaveLength(0)
        expect(body.total).toBe(0)
    })

    it('returns 200 with items when keys exist', async () => {
        ctl.selectRows = [
            { id: KEY_ID, name: 'my-key', scopes: [], type: 'mcp', createdAt: new Date().toISOString(), lastUsedAt: null },
        ]
        const res = await fetch(`${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: unknown[]; total: number }
        expect(body.items).toHaveLength(1)
        expect(body.total).toBe(1)
    })

    it('returns 500 on DB failure', async () => {
        ctl.dbThrows = true
        const res = await fetch(`${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys`)
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})

// ── POST / ────────────────────────────────────────────────────────────────

describe('POST /api/v1/workspaces/:workspaceId/api-keys', () => {
    it('returns 400 when workspaceId is not a valid UUID', async () => {
        const res = await fetch(`${baseUrl}/api/v1/workspaces/bad-id/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'my-key' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('returns 400 when name is missing', async () => {
        const res = await fetch(`${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scopes: ['read'] }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 when name is empty string', async () => {
        const res = await fetch(`${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 201 with plx_-prefixed token on success', async () => {
        ctl.insertedRow = { id: KEY_ID, name: 'ci-key', createdAt: new Date().toISOString() }
        const res = await fetch(`${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'ci-key' }),
        })
        expect(res.status).toBe(201)
        const body = await res.json() as { id: string; name: string; token: string; createdAt: string }
        expect(body.id).toBe(KEY_ID)
        expect(body.name).toBe('ci-key')
        expect(body.token).toMatch(/^plx_[0-9a-f]{64}$/)
        expect(body.createdAt).toBeDefined()
    })

    it('uses default empty scopes when scopes not provided', async () => {
        ctl.insertedRow = { id: KEY_ID, name: 'no-scope-key', createdAt: new Date().toISOString() }
        const res = await fetch(`${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'no-scope-key' }),
        })
        expect(res.status).toBe(201)
    })

    it('returns 500 on DB failure', async () => {
        ctl.dbThrows = true
        const res = await fetch(`${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'ci-key' }),
        })
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})

// ── DELETE /:keyId ────────────────────────────────────────────────────────

describe('DELETE /api/v1/workspaces/:workspaceId/api-keys/:keyId', () => {
    it('returns 400 when keyId is not a valid UUID', async () => {
        const res = await fetch(
            `${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys/not-a-uuid`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('returns 400 when workspaceId is not a valid UUID', async () => {
        const res = await fetch(
            `${baseUrl}/api/v1/workspaces/bad-ws/api-keys/${KEY_ID}`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('returns 200 { ok: true } on successful revocation', async () => {
        const res = await fetch(
            `${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys/${KEY_ID}`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(200)
        const body = await res.json() as { ok: boolean }
        expect(body.ok).toBe(true)
    })

    it('returns 500 on DB failure', async () => {
        ctl.dbThrows = true
        const res = await fetch(
            `${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/api-keys/${KEY_ID}`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})
