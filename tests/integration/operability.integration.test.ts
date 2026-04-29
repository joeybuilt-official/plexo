// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase C integration tests — operability core.
 *
 * Pins audit fixes:
 *   #6  claim-timeout requeue + admin task triage endpoints.
 *   #9  lifecycle event sink (plexo_ops_task_events).
 *
 * Runs against the dev postgres at DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import express, { type Express } from 'express'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { db, sql, eq, tasks, plexoOpsTaskEvents, workspaces } from '@plexo/db'
import { claim as queueClaim, requeueForRetry } from '@plexo/queue'
import { adminTasksRouter } from '../../apps/api/src/routes/admin/tasks.js'
import { requireServiceKey } from '../../apps/api/src/middleware/service-key-auth.js'

const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? 'test-phase-c-service-key'

// Track everything we create so afterEach can clean it up.
const createdTaskIds: string[] = []
const createdWorkspaceIds: string[] = []
const createdUserIds: string[] = []

let server: import('node:http').Server
let baseUrl: string

async function createUser(): Promise<string> {
    const id = randomUUID()
    const email = `phase-c-${id}@example.test`
    // The live users table is uuid+timestamp-without-tz (drift vs schema.ts);
    // use raw SQL with column names that match the live DB.
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
        name: `phase-c-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        ownerId,
    }).returning({ id: workspaces.id })
    if (!row) throw new Error('failed to create workspace')
    createdWorkspaceIds.push(row.id)
    return row.id
}

async function insertTask(params: {
    workspaceId: string
    status?: 'queued' | 'claimed' | 'running' | 'complete' | 'cancelled' | 'failed' | 'blocked'
    claimedAt?: Date | null
    claimedUntil?: Date | null
    attemptCount?: number
}): Promise<string> {
    const id = `phase-c-${randomUUID()}`
    await db.insert(tasks).values({
        id,
        workspaceId: params.workspaceId,
        type: 'general',
        source: 'api',
        status: params.status ?? 'queued',
        context: { phaseC: true },
        claimedAt: params.claimedAt,
        claimedUntil: params.claimedUntil,
        attemptCount: params.attemptCount ?? 0,
    })
    createdTaskIds.push(id)
    return id
}

beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set')
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY

    const app: Express = express()
    app.use(express.json())
    // Mount the admin tasks router behind requireServiceKey, matching how
    // apps/api/src/index.ts mounts it. We do NOT include requireAuth here
    // because Phase C's contract is that the service-key middleware is the
    // gate for these endpoints.
    app.use('/api/v1/admin/tasks', requireServiceKey, adminTasksRouter)

    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
    if (createdTaskIds.length > 0) {
        for (const id of createdTaskIds) {
            await db.delete(plexoOpsTaskEvents).where(eq(plexoOpsTaskEvents.taskId, id))
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

describe('Phase C — operability core', () => {
    describe('claim-timeout requeue (#6)', () => {
        it('cleanup driven by claimed_until requeues an expired claimed task and writes claim_timeout event', async () => {
            const workspaceId = await createWorkspace()
            const claimedAt = new Date(Date.now() - 10 * 60 * 1000)
            const claimedUntil = new Date(Date.now() - 5 * 60 * 1000)
            const id = await insertTask({
                workspaceId,
                status: 'claimed',
                claimedAt,
                claimedUntil,
                attemptCount: 0,
            })

            // cleanupStaleTasks() in agent-loop.ts is not exported. Replicate
            // its exact column-driven scan + per-row action so we exercise
            // the production helpers (requeueForRetry from @plexo/queue and
            // a write to plexoOpsTaskEvents that mirrors recordTaskEvent).
            const expired = await db.execute<{ id: string; workspace_id: string; status: string }>(sql`
                SELECT id, workspace_id, status FROM tasks
                WHERE status IN ('claimed', 'running')
                  AND claimed_until IS NOT NULL
                  AND claimed_until < NOW()
                LIMIT 50
            `)
            expect(expired.find(r => r.id === id)).toBeDefined()

            for (const row of expired) {
                if (row.id !== id) continue
                const retryResult = await requeueForRetry(row.id, { maxAttempts: 3, backoffBase: 120 })
                const toState = retryResult === 'requeued' ? 'queued' : 'failed'
                await db.insert(plexoOpsTaskEvents).values({
                    workspaceId: row.workspace_id,
                    taskId: row.id,
                    eventType: 'claim_timeout',
                    fromState: row.status,
                    toState,
                    metadata: { reason: 'claim_timeout', retryResult },
                })
            }

            const [after] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
            expect(after?.status).toBe('queued')
            expect(after?.claimedAt).toBeNull()
            // FINDING: requeueForRetry does NOT clear claimed_until in
            // packages/queue/src/index.ts. The brief expects it to be
            // cleared on requeue. This assertion is the spec; if it fails
            // it is an implementation bug, not a test bug.
            expect(after?.claimedUntil).toBeNull()

            await new Promise(r => setTimeout(r, 100))
            const events = await db.select().from(plexoOpsTaskEvents).where(eq(plexoOpsTaskEvents.taskId, id))
            const claimTimeoutRow = events.find(e => e.eventType === 'claim_timeout')
            expect(claimTimeoutRow).toBeDefined()
            expect(claimTimeoutRow?.toState).toBe('queued')
            expect(claimTimeoutRow?.fromState).toBe('claimed')
        })

        it('expired running task with attemptCount over max is failed (not requeued)', async () => {
            const workspaceId = await createWorkspace()
            const id = await insertTask({
                workspaceId,
                status: 'running',
                claimedAt: new Date(Date.now() - 10 * 60 * 1000),
                claimedUntil: new Date(Date.now() - 5 * 60 * 1000),
                attemptCount: 5,
            })

            const retryResult = await requeueForRetry(id, { maxAttempts: 3, backoffBase: 120 })
            expect(retryResult).toBe('max_attempts')

            const [after] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
            expect(after?.status).toBe('failed')
        })
    })

    describe('lifecycle event sink (#9)', () => {
        it('plexoOpsTaskEvents round-trips a row with jsonb metadata', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId })
            const metadata = { reason: 'unit', retries: 2, nested: { a: 1 } }

            const [inserted] = await db.insert(plexoOpsTaskEvents).values({
                workspaceId,
                taskId,
                eventType: 'claimed',
                fromState: 'queued',
                toState: 'claimed',
                metadata,
            }).returning()

            expect(inserted).toBeDefined()
            expect(inserted!.id).toBeTruthy()

            const [round] = await db.select().from(plexoOpsTaskEvents).where(eq(plexoOpsTaskEvents.id, inserted!.id)).limit(1)
            expect(round?.workspaceId).toBe(workspaceId)
            expect(round?.taskId).toBe(taskId)
            expect(round?.eventType).toBe('claimed')
            expect(round?.fromState).toBe('queued')
            expect(round?.toState).toBe('claimed')
            expect(round?.metadata).toEqual(metadata)
            expect(round?.recordedAt).toBeInstanceOf(Date)
        })

        it('NOT NULL constraints: missing to_state rejects', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId })
            await expect(
                db.execute(sql`
                    INSERT INTO plexo_ops_task_events (workspace_id, task_id, event_type, to_state, metadata)
                    VALUES (${workspaceId}::uuid, ${taskId}, 'claimed', NULL, '{}'::jsonb)
                `),
            ).rejects.toThrow()
        })

        it('NOT NULL constraints: missing event_type rejects', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId })
            await expect(
                db.execute(sql`
                    INSERT INTO plexo_ops_task_events (workspace_id, task_id, event_type, to_state, metadata)
                    VALUES (${workspaceId}::uuid, ${taskId}, NULL, 'queued', '{}'::jsonb)
                `),
            ).rejects.toThrow()
        })

        it('from_state nullable — insert with null from_state succeeds', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId })
            const [row] = await db.insert(plexoOpsTaskEvents).values({
                workspaceId,
                taskId,
                eventType: 'claimed',
                fromState: null,
                toState: 'claimed',
                metadata: {},
            }).returning()
            expect(row?.fromState).toBeNull()
        })

        it('migration 0100 indexes exist', async () => {
            const rows = await db.execute<{ indexname: string }>(sql`
                SELECT indexname FROM pg_indexes WHERE tablename = 'plexo_ops_task_events'
            `)
            const names = new Set(rows.map(r => r.indexname))
            expect(names.has('plexo_ops_task_events_workspace_task_idx')).toBe(true)
            expect(names.has('plexo_ops_task_events_event_type_idx')).toBe(true)
            expect(names.has('plexo_ops_task_events_recorded_at_idx')).toBe(true)
        })
    })

    describe('admin tasks endpoints (#6)', () => {
        it('GET without Authorization → 401', async () => {
            const res = await fetch(`${baseUrl}/api/v1/admin/tasks/anything`)
            expect(res.status).toBe(401)
            const body = await res.json() as { error: { code: string } }
            expect(body.error.code).toBe('UNAUTHORIZED')
        })

        it('GET with bad bearer → 401', async () => {
            const res = await fetch(`${baseUrl}/api/v1/admin/tasks/anything`, {
                headers: { authorization: 'Bearer not-the-real-key', 'x-app-id': 'test-app' },
            })
            expect(res.status).toBe(401)
            const body = await res.json() as { error: { code: string } }
            expect(body.error.code).toBe('INVALID_KEY')
        })

        it('GET with valid bearer + missing X-App-Id → 400', async () => {
            const res = await fetch(`${baseUrl}/api/v1/admin/tasks/anything`, {
                headers: { authorization: `Bearer ${SERVICE_KEY}` },
            })
            expect(res.status).toBe(400)
            const body = await res.json() as { error: { code: string } }
            expect(body.error.code).toBe('MISSING_APP_ID')
        })

        it('GET for non-existent task → 404', async () => {
            const res = await fetch(`${baseUrl}/api/v1/admin/tasks/01HZZZZZZZZZZZZZZZZZZZZZZZ`, {
                headers: { authorization: `Bearer ${SERVICE_KEY}`, 'x-app-id': 'test-app' },
            })
            expect(res.status).toBe(404)
            const body = await res.json() as { error: { code: string } }
            expect(body.error.code).toBe('NOT_FOUND')
        })

        it('GET for real task → 200 with task and computed keys', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({
                workspaceId,
                status: 'running',
                claimedAt: new Date(Date.now() - 30 * 1000),
                claimedUntil: new Date(Date.now() + 5 * 60 * 1000),
            })

            const res = await fetch(`${baseUrl}/api/v1/admin/tasks/${taskId}`, {
                headers: { authorization: `Bearer ${SERVICE_KEY}`, 'x-app-id': 'test-app' },
            })
            expect(res.status).toBe(200)
            const body = await res.json() as {
                task: { id: string; status: string }
                computed: { heartbeat_age_ms: number | null; claim_expired: boolean; ghost_risk: boolean }
            }
            expect(body.task.id).toBe(taskId)
            expect(body.task.status).toBe('running')
            expect(body.computed).toBeDefined()
            expect(typeof body.computed.heartbeat_age_ms === 'number' || body.computed.heartbeat_age_ms === null).toBe(true)
            expect(body.computed.heartbeat_age_ms).not.toBeNull()
            expect(typeof body.computed.claim_expired).toBe('boolean')
            expect(typeof body.computed.ghost_risk).toBe('boolean')
            expect(body.computed.claim_expired).toBe(false)
        })

        it('POST /requeue on a queued task → 200 + manual_requeue event', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId, status: 'queued' })

            const res = await fetch(`${baseUrl}/api/v1/admin/tasks/${taskId}/requeue`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${SERVICE_KEY}`,
                    'x-app-id': 'test-app',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({}),
            })
            expect(res.status).toBe(200)
            const body = await res.json() as { ok: boolean; result: string }
            expect(body.ok).toBe(true)

            await new Promise(r => setTimeout(r, 150))
            const events = await db.select().from(plexoOpsTaskEvents)
                .where(sql`${plexoOpsTaskEvents.taskId} = ${taskId} AND ${plexoOpsTaskEvents.eventType} = 'manual_requeue'`)
            expect(events.length).toBeGreaterThan(0)
            expect(events[0]!.fromState).toBe('queued')
        })

        it('POST /requeue on a complete task → 409 INVALID_STATE', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId, status: 'complete' })

            const res = await fetch(`${baseUrl}/api/v1/admin/tasks/${taskId}/requeue`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${SERVICE_KEY}`,
                    'x-app-id': 'test-app',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({}),
            })
            expect(res.status).toBe(409)
            const body = await res.json() as { error: { code: string } }
            expect(body.error.code).toBe('INVALID_STATE')
        })

        it('POST /cancel on a queued task → cancelled + manual_cancel event', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId, status: 'queued' })

            const res = await fetch(`${baseUrl}/api/v1/admin/tasks/${taskId}/cancel`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${SERVICE_KEY}`,
                    'x-app-id': 'test-app',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ reason: 'integration test' }),
            })
            expect(res.status).toBe(200)

            const [after] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
            expect(after?.status).toBe('cancelled')

            await new Promise(r => setTimeout(r, 150))
            const events = await db.select().from(plexoOpsTaskEvents)
                .where(sql`${plexoOpsTaskEvents.taskId} = ${taskId} AND ${plexoOpsTaskEvents.eventType} = 'manual_cancel'`)
            expect(events.length).toBeGreaterThan(0)
            expect(events[0]!.toState).toBe('cancelled')
        })

        it('POST /cancel on a cancelled task → 409', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId, status: 'cancelled' })

            const res = await fetch(`${baseUrl}/api/v1/admin/tasks/${taskId}/cancel`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${SERVICE_KEY}`,
                    'x-app-id': 'test-app',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({}),
            })
            expect(res.status).toBe(409)
            const body = await res.json() as { error: { code: string } }
            expect(body.error.code).toBe('INVALID_STATE')
        })
    })

    describe('claim-timeout column wiring', () => {
        it('queue.claim() writes claimed_until ≈ NOW() + CLAIM_TIMEOUT_SECONDS', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask({ workspaceId, status: 'queued' })

            const before = Date.now()
            const claimed = await queueClaim('phase-c-test-agent')
            const after = Date.now()

            expect(claimed).not.toBeNull()
            const claimedAny = claimed as unknown as Record<string, unknown>
            // claim() uses raw db.execute(sql`UPDATE ... RETURNING *`), so
            // the returned row is keyed by snake_case column names, not the
            // drizzle camelCase names. Read both forms defensively, but the
            // ground truth is what's persisted in the row.
            const claimedTaskId = (claimedAny.id as string)
            if (claimedTaskId !== taskId) {
                // Some other queued row in the shared dev DB beat us. That's
                // fine — what we care about is the column wiring on the
                // claimed row, whichever one it was. Track for cleanup ONLY
                // if it isn't ours (we already track ours).
                createdTaskIds.push(claimedTaskId)
            }

            const [persisted] = await db.select().from(tasks).where(eq(tasks.id, claimedTaskId)).limit(1)
            expect(persisted).toBeDefined()
            expect(persisted!.claimedUntil).not.toBeNull()
            const claimedUntilMs = new Date(persisted!.claimedUntil!).getTime()

            const expectedSec = parseInt(process.env.CLAIM_TIMEOUT_SECONDS ?? '300', 10)
            const lowerBound = before + expectedSec * 1000 - 5000
            const upperBound = after + expectedSec * 1000 + 5000
            expect(claimedUntilMs).toBeGreaterThanOrEqual(lowerBound)
            expect(claimedUntilMs).toBeLessThanOrEqual(upperBound)
        })
    })
})
