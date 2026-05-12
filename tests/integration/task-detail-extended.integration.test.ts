// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase F2 integration tests — extended GET /api/v1/tasks/:id (#10).
 *
 * Pins the additive shape returned by the work-detail endpoint:
 *   - events: lifecycle rows from plexo_ops_task_events, ordered ASC by
 *     recordedAt, capped at 200, filtered by BOTH taskId and workspaceId.
 *   - approval: PendingDecision when the task is awaiting_approval AND its
 *     context carries _approvalId AND the Redis record is still live; null
 *     in every other case (defensive — never 500).
 *   - The legacy { task, steps } shape is preserved (additive, not breaking).
 *
 * Workspace auth is short-circuited via the same super-admin shim Phase E
 * uses so the suite tests the route logic, not Better Auth handshakes.
 *
 * Schema-vs-DDL drift on users.id is worked around with raw SQL ::uuid casts
 * (matches Phase A/C/E).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import type { AddressInfo } from 'node:net'
import { randomUUID, randomBytes } from 'node:crypto'
import {
    db,
    sql,
    eq,
    tasks,
    plexoOpsTaskEvents,
    workspaces,
    taskSteps,
} from '@plexo/db'
import { tasksRouter } from '../../apps/api/src/routes/tasks.js'
import { requestApproval } from '../../packages/agent/src/one-way-door.js'

const createdTaskIds: string[] = []
const createdWorkspaceIds: string[] = []
const createdUserIds: string[] = []

let server: import('node:http').Server
let baseUrl: string

async function createUser(): Promise<string> {
    const id = randomUUID()
    const email = `phase-f2-${id}@example.test`
    await db.execute(sql`
        INSERT INTO users (id, email, role, created_at)
        VALUES (${id}::uuid, ${email}, 'member'::user_role, NOW())
    `)
    createdUserIds.push(id)
    return id
}

async function createWorkspace(): Promise<string> {
    const ownerId = await createUser()
    const [row] = await db.insert(workspaces).values({
        name: `phase-f2-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        ownerId,
    }).returning({ id: workspaces.id })
    if (!row) throw new Error('failed to create workspace')
    createdWorkspaceIds.push(row.id)
    return row.id
}

async function insertTask(params: {
    workspaceId: string
    status?: 'queued' | 'claimed' | 'running' | 'complete' | 'cancelled' | 'failed' | 'blocked' | 'awaiting_approval'
    context?: Record<string, unknown>
}): Promise<string> {
    const id = `phase-f2-${randomBytes(8).toString('hex')}`
    await db.insert(tasks).values({
        id,
        workspaceId: params.workspaceId,
        type: 'general',
        source: 'api',
        status: params.status ?? 'queued',
        context: params.context ?? { phaseF2: true },
    })
    createdTaskIds.push(id)
    return id
}

async function insertEvent(params: {
    workspaceId: string
    taskId: string
    eventType: string
    fromState?: string | null
    toState: string
    metadata?: Record<string, unknown>
    recordedAt?: Date
}): Promise<string> {
    const [row] = await db.insert(plexoOpsTaskEvents).values({
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        eventType: params.eventType,
        fromState: params.fromState ?? null,
        toState: params.toState,
        metadata: params.metadata ?? {},
        ...(params.recordedAt ? { recordedAt: params.recordedAt } : {}),
    }).returning({ id: plexoOpsTaskEvents.id })
    if (!row) throw new Error('failed to insert event')
    return row.id
}

interface ExtendedTaskResponse {
    task: { id: string; workspaceId: string; status: string; context: unknown }
    steps: unknown[]
    events: Array<{
        id: string
        eventType: string
        fromState: string | null
        toState: string | null
        metadata: unknown
        recordedAt: string
    }>
    approval: { id: string; taskId: string; operation: string; decision: string } | null
}

async function fetchTaskDetail(taskId: string): Promise<ExtendedTaskResponse> {
    const res = await fetch(`${baseUrl}/api/v1/tasks/${taskId}`)
    expect(res.status).toBe(200)
    return await res.json() as ExtendedTaskResponse
}

beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set')
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL must be set')

    const app: Express = express()
    app.use(express.json())
    // Test-only auth shim — same pattern as Phase E. ensureWorkspaceAccess
    // short-circuits for super-admins, so we don't have to mint a Better
    // Auth session for this route-shape suite.
    app.use((req: Request, _res: Response, next: NextFunction) => {
        req.user = { id: 'phase-f2-tester', isSuperAdmin: true } as Request['user']
        next()
    })
    app.use('/api/v1/tasks', tasksRouter)

    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
    if (createdTaskIds.length > 0) {
        for (const id of createdTaskIds) {
            await db.delete(plexoOpsTaskEvents).where(eq(plexoOpsTaskEvents.taskId, id))
            await db.delete(taskSteps).where(eq(taskSteps.taskId, id))
            await db.delete(tasks).where(eq(tasks.id, id))
        }
        createdTaskIds.length = 0
    }
    if (createdWorkspaceIds.length > 0) {
        for (const id of createdWorkspaceIds) {
            await db.delete(workspaces).where(eq(workspaces.id, id))
        }
        createdWorkspaceIds.length = 0
    }
    if (createdUserIds.length > 0) {
        for (const id of createdUserIds) {
            await db.execute(sql`DELETE FROM users WHERE id::text = ${id}`)
        }
        createdUserIds.length = 0
    }
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('Phase F2 — GET /api/v1/tasks/:id extended shape', () => {
    describe('events array', () => {
        it('returns lifecycle events ordered chronologically (asc by recordedAt)', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId })
            const t0 = new Date(Date.now() - 30_000)
            const t1 = new Date(Date.now() - 20_000)
            const t2 = new Date(Date.now() - 10_000)
            // Insert out-of-order to prove ORDER BY does the work.
            await insertEvent({ workspaceId, taskId, eventType: 'claimed', fromState: 'queued', toState: 'claimed', recordedAt: t1 })
            await insertEvent({ workspaceId, taskId, eventType: 'queued', fromState: null, toState: 'queued', recordedAt: t0 })
            await insertEvent({ workspaceId, taskId, eventType: 'running', fromState: 'claimed', toState: 'running', recordedAt: t2 })

            const body = await fetchTaskDetail(taskId)
            expect(body.events).toHaveLength(3)
            expect(body.events.map(e => e.eventType)).toEqual(['queued', 'claimed', 'running'])
            // recordedAt is serialized as an ISO string.
            expect(typeof body.events[0]!.recordedAt).toBe('string')
            expect(body.events[0]!.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
            // fromState may be null (initial event) — round-trips as JSON null.
            expect(body.events[0]!.fromState).toBeNull()
            expect(body.events[0]!.toState).toBe('queued')
        })

        it('filters by workspaceId — events for the same task_id under a different workspace are NOT returned', async () => {
            const wsA = await createWorkspace()
            const wsB = await createWorkspace()
            const taskId = await insertTask({ workspaceId: wsA })

            // One legitimate event in wsA.
            await insertEvent({ workspaceId: wsA, taskId, eventType: 'claimed', fromState: 'queued', toState: 'claimed' })
            // One cross-workspace event using the same task_id (the column is
            // plain text, no FK — so this is a real attack surface).
            await insertEvent({ workspaceId: wsB, taskId, eventType: 'leaked', fromState: 'queued', toState: 'leaked' })

            const body = await fetchTaskDetail(taskId)
            expect(body.events).toHaveLength(1)
            expect(body.events[0]!.eventType).toBe('claimed')
            expect(body.events.find(e => e.eventType === 'leaked')).toBeUndefined()
        })

        it('caps the returned array at 200 even when 250 rows exist', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId })
            const base = Date.now() - 250_000
            // 250 events, monotonically increasing recordedAt so ordering is deterministic.
            const rows = Array.from({ length: 250 }, (_, i) => ({
                workspaceId,
                taskId,
                eventType: `step_${i}`,
                fromState: 'running',
                toState: 'running',
                metadata: { i },
                recordedAt: new Date(base + i * 1000),
            }))
            await db.insert(plexoOpsTaskEvents).values(rows)

            const body = await fetchTaskDetail(taskId)
            expect(body.events).toHaveLength(200)
            // Cap takes the FIRST 200 by recordedAt asc — earliest events.
            expect(body.events[0]!.eventType).toBe('step_0')
            expect(body.events[199]!.eventType).toBe('step_199')
        })
    })

    describe('approval enrichment', () => {
        it('approval=null when task status is not awaiting_approval', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId, status: 'running', context: { _approvalId: 'irrelevant-because-status-mismatch' } })

            const body = await fetchTaskDetail(taskId)
            expect(body.approval).toBeNull()
        })

        it('approval=null when status=awaiting_approval but context lacks _approvalId (defensive)', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId, status: 'awaiting_approval', context: { reason: 'OWD' } })

            const body = await fetchTaskDetail(taskId)
            expect(body.approval).toBeNull()
        })

        it('approval=null when _approvalId is set but Redis no longer has the record (TTL miss)', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({
                workspaceId,
                status: 'awaiting_approval',
                context: { _approvalId: `phase-f2-missing-${randomBytes(6).toString('hex')}` },
            })

            const body = await fetchTaskDetail(taskId)
            expect(body.approval).toBeNull()
        })

        it('approval=PendingDecision when status=awaiting_approval AND _approvalId set AND Redis has the record', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId, status: 'awaiting_approval' })
            const approval = await requestApproval({
                taskId,
                workspaceId,
                operation: 'data_write',
                description: 'phase-f2 owd seed',
                riskLevel: 'medium',
            })
            // Splice the approval id into the task context.
            await db.update(tasks).set({ context: { _approvalId: approval.id } }).where(eq(tasks.id, taskId))

            const body = await fetchTaskDetail(taskId)
            expect(body.approval).not.toBeNull()
            expect(body.approval!.id).toBe(approval.id)
            expect(body.approval!.taskId).toBe(taskId)
            expect(body.approval!.operation).toBe('data_write')
            expect(body.approval!.decision).toBe('pending')
        })
    })

    describe('backward compatibility', () => {
        it('preserves the existing { task, steps } shape (additive only)', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId, status: 'running' })

            const body = await fetchTaskDetail(taskId)
            // Existing fields still present and structurally unchanged.
            expect(body.task).toBeDefined()
            expect(body.task.id).toBe(taskId)
            expect(body.task.workspaceId).toBe(workspaceId)
            expect(body.task.status).toBe('running')
            expect(Array.isArray(body.steps)).toBe(true)
            // New fields are present (additive).
            expect(Array.isArray(body.events)).toBe(true)
            expect(body.events).toHaveLength(0)
            expect(body.approval).toBeNull()
        })
    })
})
