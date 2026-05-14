// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Contract fuzz tests for the channels router.
 *
 * Verifies that adversarial inputs never produce a 500 and that every
 * error response has shape: { error: { code: string, message: string } }
 *
 *   1. Missing required fields → 400, not 500
 *   2. Wrong types / invalid enum values → 400
 *   3. Oversized payloads → 413
 *   4. Invalid UUIDs (workspaceId, channel id) → 400
 *   5. Empty / omitted optional fields → handled gracefully
 *   6. SQL injection probes → 400 (UUID regex blocks reach to DB)
 *   7. Every error response has shape: { error: { code: string, message: string } }
 */

import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => {
    // loadLatestSessionStates() awaits the builder directly after .where(...) —
    // no .limit() terminator. Make the builder thenable so `await builder`
    // resolves to an empty array (no paired sessions in fuzz tests).
    const emptyResult = (): Promise<unknown[]> => Promise.resolve([])
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => emptyResult()),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            emptyResult().then(res, rej),
    }
    const insertBuilder: any = {
        values: vi.fn(() => insertBuilder),
        returning: vi.fn(async () => [{ id: 'chan-id-001', workspaceId: WS, type: 'slack', name: 'general', config: {}, enabled: true }]),
    }
    const updateBuilder: any = {
        set: vi.fn(() => updateBuilder),
        where: vi.fn(async () => ({})),
    }
    const deleteBuilder: any = {
        where: vi.fn(async () => ({})),
    }
    return {
        db: {
            select: vi.fn(() => builder),
            insert: vi.fn(() => insertBuilder),
            update: vi.fn(() => updateBuilder),
            delete: vi.fn(() => deleteBuilder),
        },
        channels: { id: 'id', workspaceId: 'workspace_id', type: 'type', name: 'name', config: 'config', enabled: 'enabled' },
        pairedSessions: { channelId: 'channel_id', state: 'state', stateChangedAt: 'state_changed_at', workspaceId: 'workspace_id' },
        eq: vi.fn(),
        and: vi.fn(),
        desc: vi.fn(),
    }
})

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../telegram.js', () => ({
    registerTelegramChannel: vi.fn(async () => {}),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server helpers ────────────────────────────────────────────────────────────

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CHAN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

let server: Server | null = null
let baseUrl: string

async function ensureServer() {
    if (server) return
    const { channelsRouter } = await import('../channels.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/channels', channelsRouter)
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

const DROP_TABLE = "'; DROP TABLE channels--"
const OR_INJECTION = '" OR "1"="1'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing required fields → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('missing required fields → 400, not 500', () => {
    it('GET /api/channels — no workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('POST /api/channels — completely empty body → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })

    it('POST /api/channels — workspaceId present but type missing → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, name: 'general' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/channels — workspaceId and type present but name missing → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'slack' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH /api/channels/:id — missing workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/${CHAN_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('DELETE /api/channels/:id — no workspaceId query param → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/${CHAN_ID}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Wrong types / invalid enum values → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('wrong types / invalid enum values → 400', () => {
    it('POST /api/channels — invalid type enum → 400 INVALID_TYPE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'carrier-pigeon', name: 'test' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_TYPE')
    })

    it('POST /api/channels — type is empty string → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: '', name: 'test' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/channels — type is a number → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 42, name: 'test' }),
        })
        // numeric type is truthy so passes the missing-fields check but fails enum check
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Oversized payloads → 413
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413, not 500', () => {
    it('POST /api/channels — body exceeds 1 MB → 413', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'slack', name: 'test', config: { data: 'x'.repeat(1_200_000) } }),
        })
        expect(res.status).toBe(413)
    })

    it('PATCH /api/channels/:id — oversized config → 413', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/${CHAN_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, config: { data: 'y'.repeat(1_200_000) } }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Invalid UUIDs → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid UUID → 400, not 500', () => {
    it('GET /api/channels — non-UUID workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels?workspaceId=not-a-uuid`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('GET /api/channels — numeric workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels?workspaceId=12345`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/channels — non-UUID workspaceId → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'not-a-uuid', type: 'slack', name: 'test' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH /api/channels/:id — non-UUID channel id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/not-a-uuid`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, enabled: false }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('DELETE /api/channels/:id — non-UUID channel id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/not-a-uuid?workspaceId=${WS}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('DELETE /api/channels/:id — numeric string id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/99999?workspaceId=${WS}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Empty / omitted optional fields → handled gracefully (no 500)
// ─────────────────────────────────────────────────────────────────────────────

describe('empty / omitted optional fields → handled gracefully', () => {
    it('GET /api/channels — valid workspaceId, no channels → 200 with empty list', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.items).toEqual([])
        expect(body.total).toBe(0)
    })

    it('POST /api/channels — no config field → 201 (config defaults to {})', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'slack', name: 'general' }),
        })
        expect(res.status).toBe(201)
    })

    it('PATCH /api/channels/:id — empty update (no fields to change) → 200 ok', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/${CHAN_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. SQL injection probes → 400 (UUID regex blocks reach to DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → not a crash', () => {
    it('GET /api/channels — injection in workspaceId → 400 (UUID regex blocks it)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels?workspaceId=${encodeURIComponent(DROP_TABLE)}`)
        expect(res.status).toBe(400)
    })

    it('GET /api/channels — OR-based injection in workspaceId → 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels?workspaceId=${encodeURIComponent(OR_INJECTION)}`)
        expect(res.status).toBe(400)
    })

    it('PATCH /api/channels/:id — injection in channel id path param → 400 (UUID regex blocks it)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/${encodeURIComponent(DROP_TABLE)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, enabled: true }),
        })
        expect(res.status).toBe(400)
    })

    it('DELETE /api/channels/:id — injection in channel id path param → 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/${encodeURIComponent(OR_INJECTION)}?workspaceId=${WS}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
    })

    it('POST /api/channels — injection in name (freeform text) → 201 (parameterized, not executed)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'slack', name: DROP_TABLE }),
        })
        // Freeform text fields are safe through Drizzle parameterized queries.
        expect(res.status).toBe(201)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code: string, message: string } }', () => {
    it('GET — no workspaceId → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`)
        assertErrorShape(await res.json())
    })

    it('POST — missing fields → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        assertErrorShape(await res.json())
    })

    it('POST — invalid type enum → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'fax', name: 'retro' }),
        })
        assertErrorShape(await res.json())
    })

    it('PATCH — non-UUID channel id → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/bad-id`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        assertErrorShape(await res.json())
    })

    it('DELETE — non-UUID channel id → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/channels/bad-id?workspaceId=${WS}`, { method: 'DELETE' })
        assertErrorShape(await res.json())
    })
})
