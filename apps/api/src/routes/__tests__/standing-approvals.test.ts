// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Standing-approvals route tests (§23).
 *
 * Pins:
 *   1. GET / — 400 on missing/invalid workspaceId; 403 when workspace access
 *      denied; 200 with items array on success; 500 on DB failure
 *   2. POST / — 400 on invalid workspaceId; 400 on missing trigger or
 *      actionPattern; 201 with created row on success
 *   3. DELETE /:id — 400 on invalid id/workspaceId UUIDs; 403 on access
 *      denied; 404 when row not found; 200 { ok: true } on success
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Test state ─────────────────────────────────────────────────────────────

const ctl = {
    selectRows: [] as unknown[],
    insertedRow: null as null | Record<string, unknown>,
    deletedRow: null as null | Record<string, unknown>,
    dbThrows: false,
    accessDenied: false,
}

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        select(_fields?: unknown) {
            return {
                from: () => ({
                    where: async () => {
                        if (ctl.dbThrows) throw new Error('DB error')
                        return ctl.selectRows
                    },
                }),
            }
        },
        insert(_t: unknown) {
            return {
                values: (_row: unknown) => ({
                    returning: async () => {
                        if (ctl.dbThrows) throw new Error('DB error')
                        return ctl.insertedRow ? [ctl.insertedRow] : []
                    },
                }),
            }
        },
        delete(_t: unknown) {
            return {
                where: () => ({
                    returning: async () => {
                        if (ctl.dbThrows) throw new Error('DB error')
                        return ctl.deletedRow ? [ctl.deletedRow] : []
                    },
                }),
            }
        },
    },
    standingApprovals: {},
    eq: vi.fn(),
    and: vi.fn(),
}))

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }, _ws: string) => {
        if (ctl.accessDenied) {
            res.status(403).json({ error: { code: 'FORBIDDEN' } })
            return false
        }
        return true
    }),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Test harness ───────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

const WORKSPACE_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const APPROVAL_ID = 'c3d4e5f6-a7b8-9012-cdef-123456789012'

beforeEach(async () => {
    ctl.selectRows = []
    ctl.insertedRow = null
    ctl.deletedRow = null
    ctl.dbThrows = false
    ctl.accessDenied = false
    vi.clearAllMocks()

    if (!server) {
        const { standingApprovalsRouter } = await import('../standing-approvals.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/standing-approvals', standingApprovalsRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

// ── GET / ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/standing-approvals', () => {
    it('returns 400 when workspaceId query param is missing', async () => {
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals`)
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('returns 400 when workspaceId is not a valid UUID', async () => {
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals?workspaceId=not-a-uuid`)
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('returns 403 when workspace access is denied', async () => {
        ctl.accessDenied = true
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals?workspaceId=${WORKSPACE_ID}`)
        expect(res.status).toBe(403)
    })

    it('returns 200 with empty items array when none exist', async () => {
        ctl.selectRows = []
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals?workspaceId=${WORKSPACE_ID}`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: unknown[] }
        expect(body.items).toHaveLength(0)
    })

    it('returns 200 with items when approvals exist', async () => {
        ctl.selectRows = [
            { id: APPROVAL_ID, workspaceId: WORKSPACE_ID, trigger: 'deploy', actionPattern: 'github__*' },
        ]
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals?workspaceId=${WORKSPACE_ID}`)
        expect(res.status).toBe(200)
        const body = await res.json() as { items: unknown[] }
        expect(body.items).toHaveLength(1)
    })

    it('returns 500 on DB failure', async () => {
        ctl.dbThrows = true
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals?workspaceId=${WORKSPACE_ID}`)
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})

// ── POST / ────────────────────────────────────────────────────────────────

describe('POST /api/v1/standing-approvals', () => {
    it('returns 400 when workspaceId is missing', async () => {
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'deploy', actionPattern: 'github__*' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('returns 400 when workspaceId is not a valid UUID', async () => {
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'bad-uuid', trigger: 'deploy', actionPattern: 'github__*' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('returns 400 when trigger is missing', async () => {
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WORKSPACE_ID, actionPattern: 'github__*' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_PARAMS')
    })

    it('returns 400 when actionPattern is missing', async () => {
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WORKSPACE_ID, trigger: 'deploy' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_PARAMS')
    })

    it('returns 201 with created row on success', async () => {
        ctl.insertedRow = {
            id: APPROVAL_ID,
            workspaceId: WORKSPACE_ID,
            trigger: 'deploy',
            actionPattern: 'github__create_pull_request',
            expiresAt: null,
            createdAt: new Date().toISOString(),
        }
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceId: WORKSPACE_ID,
                trigger: 'deploy',
                actionPattern: 'github__create_pull_request',
            }),
        })
        expect(res.status).toBe(201)
        const body = await res.json() as { id: string; workspaceId: string }
        expect(body.id).toBe(APPROVAL_ID)
        expect(body.workspaceId).toBe(WORKSPACE_ID)
    })

    it('returns 500 on DB failure', async () => {
        ctl.dbThrows = true
        const res = await fetch(`${baseUrl}/api/v1/standing-approvals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceId: WORKSPACE_ID,
                trigger: 'deploy',
                actionPattern: 'github__*',
            }),
        })
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})

// ── DELETE /:id ────────────────────────────────────────────────────────────

describe('DELETE /api/v1/standing-approvals/:id', () => {
    it('returns 400 when id is not a valid UUID', async () => {
        const res = await fetch(
            `${baseUrl}/api/v1/standing-approvals/not-a-uuid?workspaceId=${WORKSPACE_ID}`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('returns 400 when workspaceId query param is invalid', async () => {
        const res = await fetch(
            `${baseUrl}/api/v1/standing-approvals/${APPROVAL_ID}?workspaceId=bad`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('returns 403 when workspace access is denied', async () => {
        ctl.accessDenied = true
        const res = await fetch(
            `${baseUrl}/api/v1/standing-approvals/${APPROVAL_ID}?workspaceId=${WORKSPACE_ID}`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(403)
    })

    it('returns 404 when approval does not exist', async () => {
        ctl.deletedRow = null
        const res = await fetch(
            `${baseUrl}/api/v1/standing-approvals/${APPROVAL_ID}?workspaceId=${WORKSPACE_ID}`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(404)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('NOT_FOUND')
    })

    it('returns 200 { ok: true } on successful deletion', async () => {
        ctl.deletedRow = { id: APPROVAL_ID, workspaceId: WORKSPACE_ID }
        const res = await fetch(
            `${baseUrl}/api/v1/standing-approvals/${APPROVAL_ID}?workspaceId=${WORKSPACE_ID}`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(200)
        const body = await res.json() as { ok: boolean }
        expect(body.ok).toBe(true)
    })

    it('returns 500 on DB failure', async () => {
        ctl.dbThrows = true
        const res = await fetch(
            `${baseUrl}/api/v1/standing-approvals/${APPROVAL_ID}?workspaceId=${WORKSPACE_ID}`,
            { method: 'DELETE' },
        )
        expect(res.status).toBe(500)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INTERNAL_ERROR')
    })
})
