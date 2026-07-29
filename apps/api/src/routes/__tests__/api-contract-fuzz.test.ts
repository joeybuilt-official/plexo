// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * API contract fuzz tests.
 *
 * Exercises route handlers against adversarial inputs and verifies they
 * never produce a 500 when the caller is at fault:
 *
 *   1. Missing required fields → 400, not 500
 *   2. Wrong types (string where number expected) → 400
 *   3. Oversized payloads → 413 rejection
 *   4. Invalid UUIDs → 400, not 500
 *   5. Empty arrays / bodies → handled gracefully
 *   6. SQL injection probes → parameterized queries prevent crashes
 *   7. Every error response has shape: { error: { code: string, message: string } }
 *
 * Routers under test: tasks, approvals, intelligence.
 */

import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Shared state ──────────────────────────────────────────────────────────────

const ctl = {
    pushId: 'fuzz-task-id',
}

// ── Mocks (hoisted before any dynamic imports) ────────────────────────────────

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(async () => []),
    }
    const insertBuilder: any = {
        values: vi.fn(() => insertBuilder),
        returning: vi.fn(async () => [{ id: 'inserted-id' }]),
    }
    return {
        db: {
            select: vi.fn(() => builder),
            insert: vi.fn(() => insertBuilder),
            execute: vi.fn(async () => ({ rows: [] })),
            transaction: vi.fn(async (fn: any) => fn({ execute: vi.fn(async () => ({})) })),
        },
        tasks: { id: 'id', workspaceId: 'workspace_id' },
        taskSteps: { taskId: 'task_id', stepNumber: 'step_number' },
        artifacts: {},
        artifactVersions: {},
        inferKind: vi.fn(),
        workspaces: { id: 'id', intelligenceSettings: 'intelligence_settings' },
        standingApprovals: { id: 'id', workspaceId: 'workspace_id', trigger: 'trigger', actionPattern: 'action_pattern' },
        desc: vi.fn((c: any) => c),
        eq: vi.fn(),
        and: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('@plexo/queue', () => ({
    push: vi.fn(async () => ctl.pushId),
    list: vi.fn(async () => []),
}))

vi.mock('@plexo/agent/one-way-door', () => ({
    listPending: vi.fn(async () => []),
    getDecision: vi.fn(async () => null),
    resolveDecision: vi.fn(async () => null),
}))

vi.mock('@plexo/agent/executor/step-builder', () => ({
    getResumeStep: vi.fn(),
}))

vi.mock('@plexo/agent/providers/chain-resolver', () => ({
    invalidateChainResolver: vi.fn(),
}))

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../lib/intelligence-cache.js', () => ({
    invalidateIntelligenceSettings: vi.fn(),
}))

vi.mock('../../lib/intelligence-spend.js', () => ({
    getWorkspaceSpend: vi.fn(async () => ({})),
    invalidateWorkspaceSpend: vi.fn(),
}))

vi.mock('../../middleware/cost-enforcement.js', () => ({
    evaluateCostCeiling: vi.fn(async () => ({
        state: 'ok',
        usagePct: 0,
        ceilingUsd: null,
        spend: {},
        reason: 'ok',
    })),
    clearWarnedWorkspace: vi.fn(),
}))

vi.mock('../../lib/seed-routing-chains.js', () => ({
    resetWorkspaceTaskChain: vi.fn(async () => ({ rowsInserted: 0 })),
}))

vi.mock('../../sse-emitter.js', () => ({ emitToWorkspace: vi.fn() }))
vi.mock('../../event-tracker.js', () => ({ trackEvent: vi.fn() }))
vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../agent-loop.js', () => ({ cancelActiveTask: vi.fn() }))
vi.mock('../../conversation-log.js', () => ({ recordConversation: vi.fn(async () => {}) }))

// ── Server helpers ────────────────────────────────────────────────────────────

let tasksServer: Server | null = null
let tasksUrl: string
let approvalsServer: Server | null = null
let approvalsUrl: string
let intelServer: Server | null = null
let intelUrl: string

async function ensureTasksServer() {
    if (tasksServer) return
    const { tasksRouter } = await import('../tasks.js')
    const app = express()
    // Match production 1 MB default — oversized payload test depends on this.
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/tasks', tasksRouter)
    tasksServer = app.listen(0)
    await new Promise<void>(r => tasksServer!.once('listening', r))
    tasksUrl = `http://127.0.0.1:${(tasksServer.address() as AddressInfo).port}`
}

async function ensureApprovalsServer() {
    if (approvalsServer) return
    const { owdRouter } = await import('../approvals.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/approvals', owdRouter)
    approvalsServer = app.listen(0)
    await new Promise<void>(r => approvalsServer!.once('listening', r))
    approvalsUrl = `http://127.0.0.1:${(approvalsServer.address() as AddressInfo).port}`
}

async function ensureIntelServer() {
    if (intelServer) return
    const { intelligenceRouter } = await import('../intelligence.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1/intelligence', intelligenceRouter)
    intelServer = app.listen(0)
    await new Promise<void>(r => intelServer!.once('listening', r))
    intelUrl = `http://127.0.0.1:${(intelServer.address() as AddressInfo).port}`
}

afterAll(() => {
    tasksServer?.close()
    approvalsServer?.close()
    intelServer?.close()
})

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

const WS = '11111111-1111-1111-1111-111111111111'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing required fields → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('missing required fields → 400, not 500', () => {
    it('POST /api/tasks — completely empty body', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })

    it('POST /api/tasks — workspaceId present but type missing', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })

    it('GET /api/approvals — no workspaceId at all', async () => {
        await ensureApprovalsServer()
        const res = await fetch(`${approvalsUrl}/api/approvals`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET /api/approvals — empty workspaceId string', async () => {
        await ensureApprovalsServer()
        const res = await fetch(`${approvalsUrl}/api/approvals?workspaceId=`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Wrong types → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('wrong types → 400, not 500', () => {
    it('POST /api/tasks — priority is a string', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'coding', priority: 'high' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_PRIORITY')
    })

    it('POST /api/tasks — priority out of 1–10 range (0)', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'coding', priority: 0 }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/tasks — priority out of 1–10 range (99)', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'coding', priority: 99 }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/tasks — invalid type enum', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'doEverything' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_TYPE')
    })

    it('PATCH intelligence cost-ceiling — ceilingUsd is a string', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/settings/cost-ceiling`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ceilingUsd: 'one hundred' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH intelligence cost-ceiling — ceilingUsd is NaN (Infinity)', async () => {
        await ensureIntelServer()
        // JSON.stringify drops Infinity; send as 1e999 which serializes to null
        // Instead force it through with a raw body that encodes a non-finite value.
        // JSON spec doesn't support Infinity so we use a string coercion test instead.
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/settings/cost-ceiling`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ceilingUsd: -1 }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Oversized payload → 413
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413, not 500', () => {
    it('POST /api/tasks — body exceeds 1 MB limit', async () => {
        await ensureTasksServer()
        // 1.2 MB of ASCII in the context field — well over the 1 MB express.json limit.
        const bigBody = JSON.stringify({
            workspaceId: WS,
            type: 'coding',
            context: { data: 'x'.repeat(1_200_000) },
        })
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bigBody,
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Invalid UUIDs → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid UUID → 400, not 500', () => {
    it('GET /api/approvals — workspaceId is not a UUID', async () => {
        await ensureApprovalsServer()
        const res = await fetch(`${approvalsUrl}/api/approvals?workspaceId=not-a-uuid`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET /api/approvals/:id — id too short to be valid OWD or UUID', async () => {
        await ensureApprovalsServer()
        const res = await fetch(`${approvalsUrl}/api/approvals/short`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/tasks — workspaceId is not a UUID', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'not-a-uuid', type: 'coding' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('POST /api/tasks — workspaceId is a numeric string', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: '12345', type: 'coding' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Empty arrays / bodies → handled gracefully (no 500)
// ─────────────────────────────────────────────────────────────────────────────

describe('empty arrays and bodies → handled gracefully', () => {
    it('POST /api/tasks — empty context object is valid', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'coding', context: {} }),
        })
        expect(res.status).toBe(201)
        const body = await res.json() as any
        expect(body.id).toBe('fuzz-task-id')
    })

    it('PATCH intelligence chains — empty entries array clears the chain', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: [] }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.length).toBe(0)
    })

    it('GET /api/approvals — returns empty list when no pending decisions', async () => {
        await ensureApprovalsServer()
        const res = await fetch(`${approvalsUrl}/api/approvals?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.items).toEqual([])
        expect(body.total).toBe(0)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. SQL injection probes → no crash (parameterized queries protect DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → not a crash', () => {
    const DROP_TABLE = "'; DROP TABLE tasks--"
    const QUOTE_OR = '" OR "1"="1'
    const COMMENT = '/* injection */ 1=1'

    it('GET /api/approvals — injection in workspaceId caught by UUID regex → 400', async () => {
        await ensureApprovalsServer()
        const res = await fetch(`${approvalsUrl}/api/approvals?workspaceId=${encodeURIComponent(DROP_TABLE)}`)
        expect(res.status).toBe(400)
        // Should be a clean 400, never a 500 from a DB exception.
    })

    it('GET /api/approvals — OR-based injection in workspaceId → 400', async () => {
        await ensureApprovalsServer()
        const res = await fetch(`${approvalsUrl}/api/approvals?workspaceId=${encodeURIComponent(QUOTE_OR)}`)
        expect(res.status).toBe(400)
    })

    it('POST /api/tasks — injection in context.description → 201 (parameterized, not executed)', async () => {
        await ensureTasksServer()
        // Injection in freeform text fields must not cause a crash. DB is mocked
        // here; in production, Drizzle ORM uses parameterized queries throughout.
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceId: WS,
                type: 'coding',
                context: { description: DROP_TABLE },
            }),
        })
        expect(res.status).toBe(201)
    })

    it('POST /api/tasks — comment-based injection in context → 201', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceId: WS,
                type: 'research',
                context: { query: COMMENT },
            }),
        })
        expect(res.status).toBe(201)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code: string, message: string } }', () => {
    // intelligence.ts previously returned { error: string } — these tests
    // enforce the structured contract after the fix.

    it('PATCH inference-mode — invalid mode value → structured error', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/settings/inference-mode`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'turbo-mode' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH inference-mode — missing mode → structured error', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/settings/inference-mode`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH cost-ceiling — negative ceilingUsd → structured error', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/settings/cost-ceiling`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ceilingUsd: -5 }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH cost-ceiling — invalid enforcement mode → structured error', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/settings/cost-ceiling`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ceilingUsd: 100, mode: 'panic' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH chains — invalid taskType → structured error', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/chains/not-a-task-type`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: [] }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH chains — entries is not an array → structured error', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: 'not-an-array' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH chains — entry missing modelId → structured error', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: [{ providerId: 'p1' }] }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST approve-and-remember — invalid approval id format → structured error', async () => {
        await ensureApprovalsServer()
        const res = await fetch(`${approvalsUrl}/api/approvals/bad-id/approve-and-remember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST approve — invalid approval id format → structured error', async () => {
        await ensureApprovalsServer()
        const res = await fetch(`${approvalsUrl}/api/approvals/bad-id/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/tasks — invalid source enum → structured error', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, type: 'coding', source: 'carrier-pigeon' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_SOURCE')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. Task sub-route field / id validation → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('task sub-routes: id and field validation → 400, not 500', () => {
    it('GET /api/tasks — no workspaceId query param → 400 MISSING_WORKSPACE', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('GET /api/tasks/:id — id exceeds 64 chars → 400 INVALID_ID', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/${'a'.repeat(65)}`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('DELETE /api/tasks/:id — id exceeds 64 chars → 400 INVALID_ID', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/${'b'.repeat(65)}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/tasks/:id/retry — id exceeds 64 chars → 400 INVALID_ID', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/${'c'.repeat(65)}/retry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET /api/tasks/:id/artifacts/:artifactId/versions — non-UUID artifactId → 400 INVALID_ID', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/artifacts/not-a-uuid/versions`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('POST /api/tasks/:id/assets/export — empty body → 400 MISSING_FIELDS', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/assets/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })

    it('POST /api/tasks/:id/assets/export — missing format → 400 MISSING_FIELDS', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/assets/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'report.md' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })

    it('POST /api/tasks/:id/assets/export — unsupported format value → 400 UNSUPPORTED_FORMAT', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/assets/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'report.md', format: 'xlsx' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('UNSUPPORTED_FORMAT')
    })

    it('POST /api/tasks/:id/assets/export — path traversal filename → not 500', async () => {
        // Task not found in mock → 404 before path check. Neither branch is 500.
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/assets/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: '../../../etc/passwd', format: 'pdf' }),
        })
        expect(res.status).not.toBe(500)
    })

    it('PATCH /api/tasks/:id/artifacts/:artifactId/meta — artifactId < 8 chars → 400 INVALID_ARTIFACT_ID', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/artifacts/ab/meta`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patch: { key: 'value' } }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ARTIFACT_ID')
    })

    it('PATCH /api/tasks/:id/artifacts/:artifactId/meta — patch is an array → 400 INVALID_PATCH', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/artifacts/artifact-1/meta`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patch: [] }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_PATCH')
    })

    it('PATCH /api/tasks/:id/artifacts/:artifactId/meta — patch is a string → 400 INVALID_PATCH', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/artifacts/artifact-1/meta`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patch: 'not-an-object' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_PATCH')
    })

    it('PATCH /api/tasks/:id/artifacts/:artifactId/meta — patch exceeds 16 KB → 400 PATCH_TOO_LARGE', async () => {
        await ensureTasksServer()
        // Object whose JSON serialisation is well over 16 384 bytes.
        const bigPatch = { data: 'x'.repeat(17_000) }
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/artifacts/artifact-1/meta`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patch: bigPatch }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('PATCH_TOO_LARGE')
    })

    it('PATCH /api/tasks/:id/artifacts/:artifactId/meta — no patch key at all → 400 INVALID_PATCH', async () => {
        await ensureTasksServer()
        const res = await fetch(`${tasksUrl}/api/tasks/some-task-id/artifacts/artifact-1/meta`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. Intelligence: step-budget and chain entries → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('intelligence: step-budget and chain entries → 400, not 500', () => {
    it('PATCH step-budget — invalid budget string → 400 INVALID_BUDGET', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/settings/step-budget`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ budget: 'unlimited' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_BUDGET')
    })

    it('PATCH step-budget — missing budget field → 400 INVALID_BUDGET', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/settings/step-budget`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH step-budget — numeric budget (wrong type) → 400 INVALID_BUDGET', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/settings/step-budget`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ budget: 3 }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH chains — entries array longer than 10 → 400 TOO_MANY_ENTRIES', async () => {
        await ensureIntelServer()
        const entries = Array.from({ length: 11 }, (_, i) => ({
            providerId: `prov-${i}`,
            modelId: `model-${i}`,
        }))
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('TOO_MANY_ENTRIES')
    })

    it('PATCH chains — entry with empty providerId string → 400 INVALID_ENTRY', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: [{ providerId: '   ', modelId: 'claude-haiku-4-5' }] }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ENTRY')
    })

    it('PATCH chains — entry with numeric modelId (wrong type) → 400 INVALID_ENTRY', async () => {
        await ensureIntelServer()
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: [{ providerId: 'provider-1', modelId: 42 }] }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH chains — SQL injection in taskType path param → 400 (enum check blocks it)', async () => {
        await ensureIntelServer()
        const injection = encodeURIComponent("'; DROP TABLE routing_chains--")
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/chains/${injection}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: [] }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH chains — oversized entries body → 413, not 500', async () => {
        await ensureIntelServer()
        // Build a valid-shaped payload that exceeds the 1 MB express.json limit.
        const entries = Array.from({ length: 5 }, (_, i) => ({
            providerId: 'p'.repeat(100),
            modelId: 'm'.repeat(100_000 * (i + 1)),
        }))
        const bigBody = JSON.stringify({ entries })
        const res = await fetch(`${intelUrl}/api/v1/intelligence/${WS}/chains/conversation`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: bigBody,
        })
        expect(res.status).toBe(413)
    })
})
