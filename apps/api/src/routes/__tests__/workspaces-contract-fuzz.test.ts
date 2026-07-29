// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Contract fuzz tests for the workspaces router.
 *
 *   1. Missing required fields → 400, not 500
 *   2. Wrong types / oversized values → 400
 *   3. Oversized payloads → 413, not 500
 *   4. Invalid UUIDs → 400, not 500
 *   5. Empty / omitted optional fields → handled gracefully
 *   6. SQL injection in freeform text → handled gracefully (not 500)
 *   7. Every error has shape: { error: { code: string, message: string } }
 */

import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// First ensureServer() spins an Express app and the suite runs many fuzz
// cases; under parallel turbo load the first request can exceed the 15s
// default. Raise this file's timeouts so the gate is reliable (no logic change).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// ── Shared state ──────────────────────────────────────────────────────────────

const ctl = {
    authed: true,
    userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    isSuperAdmin: false,
    role: 'owner' as string,
    wsExists: true,
    insertedId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    countWs: 2,
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        offset: vi.fn(() => builder),
        limit: vi.fn(async (n: number) => {
            if (n === 2) {
                // "last workspace" guard: return ctl.countWs workspaces
                return Array.from({ length: ctl.countWs }, (_, i) => ({ id: `ws-${i}` }))
            }
            return ctl.wsExists
                ? [{ id: WS, name: 'Fuzz WS', ownerId: ctl.userId, settings: {}, createdAt: new Date() }]
                : []
        }),
    }
    const insertBuilder: any = {
        values: vi.fn(() => insertBuilder),
        onConflictDoNothing: vi.fn(() => insertBuilder),
        returning: vi.fn(async () => [{ id: ctl.insertedId, name: 'New WS' }]),
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
            transaction: vi.fn(async (fn: any) => {
                const txInsert: any = {
                    values: vi.fn(() => txInsert),
                    onConflictDoNothing: vi.fn(() => txInsert),
                    returning: vi.fn(async () => [{ id: ctl.insertedId, name: 'Created WS' }]),
                }
                return fn({ insert: vi.fn(() => txInsert) })
            }),
            execute: vi.fn(async () => ({})),
        },
        workspaces: { id: 'id', name: 'name', ownerId: 'owner_id', settings: 'settings', createdAt: 'created_at', intelligenceSettings: 'intelligence_settings' },
        workspaceMembers: { workspaceId: 'workspace_id', userId: 'user_id', role: 'role' },
        tasks: { id: 'id', workspaceId: 'workspace_id', status: 'status' },
        conversations: { workspaceId: 'workspace_id', createdAt: 'created_at' },
        memoryEntries: { workspaceId: 'workspace_id' },
        behaviorRules: { workspaceId: 'workspace_id' },
        DEFAULT_WORKSPACE_SETTINGS: {},
        DEFAULT_INTELLIGENCE_SETTINGS: {},
        desc: vi.fn((c: any) => c),
        eq: vi.fn(),
        and: vi.fn(),
        inArray: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async (req: any, _res: any, _id: string) => {
        req.workspaceRole = ctl.role
        return true
    }),
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../event-tracker.js', () => ({ trackEvent: vi.fn() }))
vi.mock('../../agent-loop.js', () => ({ cancelActiveTask: vi.fn() }))
vi.mock('@plexo/storage', () => ({ deleteByPrefix: vi.fn(async () => {}) }))
vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Constants ─────────────────────────────────────────────────────────────────

const WS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const DROP_TABLE = "'; DROP TABLE workspaces--"
const OR_INJECTION = '" OR "1"="1'

// ── Server helpers ────────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function ensureServer() {
    if (server) return
    const { workspacesRouter } = await import('../workspaces.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    // Inject auth context — mirrors what requireAuth middleware does in production
    app.use((req: any, _res, next) => {
        if (ctl.authed) {
            req.user = { id: ctl.userId, isSuperAdmin: ctl.isSuperAdmin }
        }
        next()
    })
    app.use('/api/workspaces', workspacesRouter)
    server = app.listen(0)
    await new Promise<void>(r => server!.once('listening', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

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

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing required fields → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('missing required fields → 400, not 500', () => {
    it('POST /api/workspaces — completely empty body → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })

    it('POST /api/workspaces — name is empty string → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })

    it('POST /api/workspaces — name is whitespace only → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '   ' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })

    it('PATCH /api/workspaces/:id — no name or settings → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/${WS}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Wrong types / oversized values → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('wrong types / oversized values → 400', () => {
    it('POST /api/workspaces — name exceeds 200 chars → 400 INVALID_NAME', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x'.repeat(201) }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_NAME')
    })

    it('POST /api/workspaces — name exactly 201 chars → 400 INVALID_NAME', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'a'.repeat(201) }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH /api/workspaces/:id — name exceeds 200 chars → 400 INVALID_NAME', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/${WS}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'z'.repeat(201) }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_NAME')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Oversized payloads → 413, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413, not 500', () => {
    it('POST /api/workspaces — body exceeds 1 MB → 413', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'My Workspace', settings: { data: 'x'.repeat(1_200_000) } }),
        })
        expect(res.status).toBe(413)
    })

    it('PATCH /api/workspaces/:id — body exceeds 1 MB → 413', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/${WS}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { blob: 'y'.repeat(1_200_000) } }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Invalid UUIDs → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid UUID → 400, not 500', () => {
    it('GET /api/workspaces/:id — non-UUID id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/not-a-uuid`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('GET /api/workspaces/:id — numeric string id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/12345`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('DELETE /api/workspaces/:id — non-UUID id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/not-a-uuid`, { method: 'DELETE' })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('DELETE /api/workspaces/:id — SQL injection in id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(DROP_TABLE)}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH /api/workspaces/:id — non-UUID id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/not-a-uuid`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Updated' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('PATCH /api/workspaces/:id — OR-injection in id → 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(OR_INJECTION)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'hack' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Empty / omitted optional fields → handled gracefully
// ─────────────────────────────────────────────────────────────────────────────

describe('empty / omitted optional fields → handled gracefully', () => {
    it('POST /api/workspaces — valid name, no settings → 201', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'My Workspace' }),
        })
        expect(res.status).toBe(201)
        const body = await res.json() as any
        expect(body.id).toBe(ctl.insertedId)
    })

    it('PATCH /api/workspaces/:id — settings only (no name) → 200', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/${WS}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { theme: 'dark' } }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
    })

    it('PATCH /api/workspaces/:id — name only (no settings) → 200', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/${WS}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Renamed WS' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. SQL injection in freeform fields → not a crash
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection in freeform fields → not a crash', () => {
    it('POST — injection in name → 201 (Drizzle parameterized queries)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: DROP_TABLE }),
        })
        // DROP_TABLE is 23 chars — valid length, passes name check.
        // Drizzle parameterizes it. Mock returns 201.
        expect(res.status).toBe(201)
    })

    it('POST — OR-injection in name → 201', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: OR_INJECTION }),
        })
        expect(res.status).toBe(201)
    })

    it('PATCH — injection in settings JSON → 200 (JSONB merge, not interpolated)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/${WS}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { note: DROP_TABLE } }),
        })
        expect(res.status).toBe(200)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code, message } }', () => {
    it('POST empty body → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        assertErrorShape(await res.json())
    })

    it('POST name too long → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'a'.repeat(201) }),
        })
        assertErrorShape(await res.json())
    })

    it('GET /:id non-UUID → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/bad-id`)
        assertErrorShape(await res.json())
    })

    it('DELETE /:id non-UUID → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/bad-id`, { method: 'DELETE' })
        assertErrorShape(await res.json())
    })

    it('PATCH /:id non-UUID → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/bad-id`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        assertErrorShape(await res.json())
    })

    it('PATCH /:id no fields → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/workspaces/${WS}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        assertErrorShape(await res.json())
    })
})
