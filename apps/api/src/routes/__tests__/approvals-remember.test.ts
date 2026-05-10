// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * UI-audit Phase 1 — approve-and-remember handler tests.
 *
 * Pins:
 *   1. Happy path: valid pending decision → 200 + standingApprovalId +
 *      one insert row in standing_approvals + SSE frames emitted.
 *   2. Already-resolved / missing decision → 404 (resolveDecision returns null).
 *
 * Follows the existing route-test pattern: mount the router on a throwaway
 * express app, mock `@plexo/db` + `@plexo/agent/one-way-door` + the SSE
 * emitter so no DB/network hits fire.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Test state ───────────────────────────────────────────────────────

const ctl = {
    /** Value resolveDecision() will return on the next call. null simulates missing/expired/already-resolved. */
    nextDecision: null as null | {
        id: string
        workspaceId: string
        operation: string
        taskId: string
        riskLevel: 'low' | 'medium' | 'high' | 'critical'
        description: string
        decision: 'approved'
        createdAt: string
        decidedBy: string
    },
    /** Captured inserts into standing_approvals. */
    inserted: [] as Array<{ workspaceId: string; trigger: string; actionPattern: string }>,
    /** Next id the fake insert returns. */
    nextStandingId: 'stand-id-1',
    /** SSE frames emitted via emitToWorkspace. */
    sseFrames: [] as Array<{ workspaceId: string; frame: Record<string, unknown> }>,
}

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('@plexo/agent/one-way-door', () => ({
    listPending: vi.fn(async () => []),
    getDecision: vi.fn(async () => ctl.nextDecision),
    resolveDecision: vi.fn(async (_id: string, _decision: string, _by: string) => ctl.nextDecision),
}))

vi.mock('@plexo/db', () => {
    const standingApprovalsSentinel = {
        __table: 'standing_approvals',
        id: 'id',
        workspaceId: 'workspace_id',
        trigger: 'trigger',
        actionPattern: 'action_pattern',
    }
    function makeInsertBuilder() {
        let captured: { workspaceId: string; trigger: string; actionPattern: string } | null = null
        const builder = {
            values(row: { workspaceId: string; trigger: string; actionPattern: string }) {
                captured = row
                return builder
            },
            async returning() {
                if (captured) ctl.inserted.push(captured)
                return [{ id: ctl.nextStandingId }]
            },
        }
        return builder
    }
    return {
        db: {
            insert: (_t: unknown) => makeInsertBuilder(),
            select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
        },
        standingApprovals: standingApprovalsSentinel,
        eq: vi.fn(),
    }
})

vi.mock('../../sse-emitter.js', () => ({
    emitToWorkspace: vi.fn((workspaceId: string, frame: Record<string, unknown>) => {
        ctl.sseFrames.push({ workspaceId, frame })
    }),
}))

vi.mock('../../event-tracker.js', () => ({
    trackEvent: vi.fn(),
}))

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Test harness boot ────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

beforeEach(async () => {
    ctl.nextDecision = null
    ctl.inserted = []
    ctl.nextStandingId = 'stand-id-1'
    ctl.sseFrames = []
    if (!server) {
        const { owdRouter } = await import('../approvals.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/approvals', owdRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

// ── Tests ────────────────────────────────────────────────────────────

const APPROVAL_ID = 'abcdef1234567890abcdef12'
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

describe('POST /api/v1/approvals/:id/approve-and-remember', () => {
    it('happy path: resolves decision, inserts standing_approval, emits SSE', async () => {
        ctl.nextDecision = {
            id: APPROVAL_ID,
            workspaceId: WORKSPACE_ID,
            operation: 'github__create_pull_request',
            taskId: 'task-1',
            riskLevel: 'medium',
            description: 'Create PR on repo foo/bar',
            decision: 'approved',
            createdAt: new Date().toISOString(),
            decidedBy: 'dashboard',
        }

        const res = await fetch(`${baseUrl}/api/v1/approvals/${APPROVAL_ID}/approve-and-remember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: 'dashboard' }),
        })

        expect(res.status).toBe(200)
        const body = await res.json() as { ok: boolean; standingApprovalId: string | null }
        expect(body.ok).toBe(true)
        expect(body.standingApprovalId).toBe('stand-id-1')

        // One row inserted with operation as both trigger + actionPattern
        expect(ctl.inserted).toHaveLength(1)
        expect(ctl.inserted[0]).toEqual({
            workspaceId: WORKSPACE_ID,
            trigger: 'github__create_pull_request',
            actionPattern: 'github__create_pull_request',
        })

        // Two SSE frames: owd_approved + standing_approval_created
        const types = ctl.sseFrames.map((f) => f.frame['type'])
        expect(types).toContain('owd_approved')
        expect(types).toContain('standing_approval_created')
    })

    it('returns 404 when the decision is missing or already resolved', async () => {
        ctl.nextDecision = null // resolveDecision returns null → already resolved / expired

        const res = await fetch(`${baseUrl}/api/v1/approvals/${APPROVAL_ID}/approve-and-remember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: 'dashboard' }),
        })

        expect(res.status).toBe(404)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('NOT_FOUND')

        // No insert should have happened
        expect(ctl.inserted).toHaveLength(0)
    })
})
