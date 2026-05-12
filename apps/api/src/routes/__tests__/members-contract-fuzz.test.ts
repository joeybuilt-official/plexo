// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Contract fuzz tests for the members and invites routers.
 *
 * Verifies that adversarial inputs never produce a 500 and that every
 * error response has shape: { error: { code: string, message: string } }
 *
 *   1. GET  /api/workspaces/:id/members  — invalid workspaceId UUID → 400
 *   2. POST /api/workspaces/:id/members  — missing role (unauthenticated) → 403
 *   3. POST /api/workspaces/:id/invite   — missing / invalid fields → 400
 *   4. POST /api/invites/:token/accept   — missing / invalid userId → 400
 *   5. SQL injection probes in UUID fields → 400 (caught by UUID_RE)
 *   6. Every error response has shape: { error: { code, message } }
 */

import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        innerJoin: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(async () => []),
    }
    const insertBuilder: any = {
        values: vi.fn(() => insertBuilder),
        returning: vi.fn(async () => [{ id: 'inserted-id' }]),
        onConflictDoUpdate: vi.fn(() => insertBuilder),
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
        workspaceMembers: { id: 'id', workspaceId: 'workspace_id', userId: 'user_id', role: 'role', joinedAt: 'joined_at' },
        workspaceInvites: { id: 'id', workspaceId: 'workspace_id', token: 'token', role: 'role', invitedEmail: 'invited_email', invitedByUserId: 'invited_by_user_id', expiresAt: 'expires_at', usedAt: 'used_at', usedByUserId: 'used_by_user_id' },
        users: { id: 'id', email: 'email', name: 'name' },
        workspaces: { id: 'id', name: 'name', ownerId: 'owner_id' },
        eq: vi.fn(),
        and: vi.fn(),
        desc: vi.fn((c: any) => c),
    }
})

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../audit.js', () => ({ audit: vi.fn() }))

// ── Server helpers ────────────────────────────────────────────────────────────

let membersServer: Server | null = null
let membersUrl: string
let invitesServer: Server | null = null
let invitesUrl: string

async function ensureMembersServer() {
    if (membersServer) return
    const { membersRouter } = await import('../members.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    // Mount with mergeParams so :id from the parent route is available.
    app.use('/api/workspaces/:id/members', membersRouter)
    membersServer = app.listen(0)
    await new Promise<void>(r => membersServer!.once('listening', r))
    membersUrl = `http://127.0.0.1:${(membersServer.address() as AddressInfo).port}`
}

async function ensureInvitesServer() {
    if (invitesServer) return
    const { invitesRouter } = await import('../members.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/invites', invitesRouter)
    invitesServer = app.listen(0)
    await new Promise<void>(r => invitesServer!.once('listening', r))
    invitesUrl = `http://127.0.0.1:${(invitesServer.address() as AddressInfo).port}`
}

afterAll(() => {
    membersServer?.close()
    invitesServer?.close()
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

const WS = '22222222-2222-2222-2222-222222222222'
const DROP_TABLE = "'; DROP TABLE workspace_members--"
const OR_INJECTION = '" OR "1"="1'

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET members — invalid workspaceId → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/workspaces/:id/members — invalid workspaceId → 400', () => {
    it('non-UUID workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/not-a-uuid/members`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('numeric string workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/12345/members`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('SQL injection in workspaceId → 400 (UUID regex blocks it)', async () => {
        await ensureMembersServer()
        const res = await fetch(
            `${membersUrl}/api/workspaces/${encodeURIComponent(DROP_TABLE)}/members`,
        )
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('OR-based injection in workspaceId → 400', async () => {
        await ensureMembersServer()
        const res = await fetch(
            `${membersUrl}/api/workspaces/${encodeURIComponent(OR_INJECTION)}/members`,
        )
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST members — no workspace role → 403 with proper error shape
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/workspaces/:id/members — role check → 403 with proper error shape', () => {
    it('request without workspaceRole → 403 FORBIDDEN (not 500)', async () => {
        // req.workspaceRole is undefined when middleware is absent — handler
        // must return 403 FORBIDDEN, never leak a 500.
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'user@example.com', role: 'member' }),
        })
        expect(res.status).toBe(403)
        assertErrorShape(await res.json())
    })

    it('PATCH member role without workspaceRole → 403 FORBIDDEN (not 500)', async () => {
        await ensureMembersServer()
        const userId = '33333333-3333-3333-3333-333333333333'
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members/${userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'admin' }),
        })
        expect(res.status).toBe(403)
        assertErrorShape(await res.json())
    })

    it('DELETE member without workspaceRole → 403 FORBIDDEN (not 500)', async () => {
        await ensureMembersServer()
        const userId = '44444444-4444-4444-4444-444444444444'
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members/${userId}`, {
            method: 'DELETE',
        })
        expect(res.status).toBe(403)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST invite — input validation → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/workspaces/:id/members/invite — input validation → 400', () => {
    it('non-UUID workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/not-a-uuid/members/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invitedByUserId: WS }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('missing invitedByUserId → 400 MISSING_USER', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'member' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_USER')
    })

    it('non-UUID invitedByUserId → 400 INVALID_USER', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invitedByUserId: 'not-a-uuid' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_USER')
    })

    it('invalid role string → 400 INVALID_ROLE', async () => {
        await ensureMembersServer()
        const userId = '55555555-5555-5555-5555-555555555555'
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invitedByUserId: userId, role: 'superuser' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ROLE')
    })

    it('SQL injection in invitedByUserId → 400 (UUID regex blocks it)', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invitedByUserId: DROP_TABLE }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('empty body → 400 MISSING_USER', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST invites/:token/accept — input validation → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/invites/:token/accept — input validation → 400', () => {
    it('missing userId → 400 MISSING_USER', async () => {
        await ensureInvitesServer()
        const res = await fetch(`${invitesUrl}/api/invites/some-token/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_USER')
    })

    it('non-UUID userId → 400 INVALID_USER', async () => {
        await ensureInvitesServer()
        const res = await fetch(`${invitesUrl}/api/invites/some-token/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'not-a-uuid' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_USER')
    })

    it('SQL injection in userId → 400 (UUID regex blocks it)', async () => {
        await ensureInvitesServer()
        const res = await fetch(`${invitesUrl}/api/invites/some-token/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: DROP_TABLE }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('OR-based injection in userId → 400', async () => {
        await ensureInvitesServer()
        const res = await fetch(`${invitesUrl}/api/invites/some-token/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: OR_INJECTION }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('oversized body → 413, not 500', async () => {
        await ensureInvitesServer()
        const res = await fetch(`${invitesUrl}/api/invites/some-token/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: WS, junk: 'x'.repeat(1_200_000) }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Error response shape: { error: { code, message } } on all error paths
// ─────────────────────────────────────────────────────────────────────────────

describe('members/invites: every error has { error: { code: string, message: string } }', () => {
    it('GET members — non-UUID workspaceId → structured 400', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/bad/members`)
        assertErrorShape(await res.json())
    })

    it('POST invite — missing invitedByUserId → structured 400', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'viewer' }),
        })
        assertErrorShape(await res.json())
    })

    it('POST accept — missing userId → structured 400', async () => {
        await ensureInvitesServer()
        const res = await fetch(`${invitesUrl}/api/invites/tok/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        assertErrorShape(await res.json())
    })

    it('POST members — no role → structured 403', async () => {
        await ensureMembersServer()
        const res = await fetch(`${membersUrl}/api/workspaces/${WS}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'x@x.com' }),
        })
        assertErrorShape(await res.json())
    })
})
