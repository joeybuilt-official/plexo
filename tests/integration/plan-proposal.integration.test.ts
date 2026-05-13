// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase F1 integration tests — plan_proposal SSE event (#10).
 *
 * Verifies the new structured plan card emission:
 *   1. Plans with steps.length >= 3 and no OWD → plan_proposal event emitted
 *      with requiresApproval=false, approvalId=null, full PlanStep[].
 *   2. Plans with steps.length >= 3 + OWD → plan_proposal carries
 *      requiresApproval=true and the approvalId returned by requestApproval.
 *   3. Plans with steps.length < 3 → NO plan_proposal event (existing
 *      task_planned still fires in production; this suite only asserts the
 *      gate behavior of emitPlanProposal).
 *   4. plexo_ops_task_events row written with event_type='plan_proposed' for
 *      gated cases; absent for the <3 case.
 *
 * We exercise the production helper `emitPlanProposal` directly rather than
 * spinning the full agent-loop (which needs LLM credentials). SSE delivery is
 * verified via the internal subscriber registered through onAgentEvent —
 * matches how Telegram/Slack adapters consume events in prod.
 *
 * Schema-vs-DDL drift on users.id is worked around with raw SQL ::uuid casts
 * (matches Phase A's approach used in confirm-gate.integration.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
import {
    db,
    sql,
    eq,
    tasks,
    plexoOpsTaskEvents,
    workspaces,
} from '@plexo/db'
import { emitPlanProposal } from '../../apps/api/src/agent-loop.js'
import { onAgentEvent, type AgentEvent } from '../../apps/api/src/sse-emitter.js'
import { requestApproval } from '../../packages/agent/src/one-way-door.js'
import type { ExecutionPlan, PlanStep, OneWayDoor } from '../../packages/agent/src/types.js'

const createdTaskIds: string[] = []
const createdWorkspaceIds: string[] = []
const createdUserIds: string[] = []

async function createUser(): Promise<string> {
    const id = randomUUID()
    const email = `phase-f1-${id}@example.test`
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
        name: `phase-f1-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        ownerId,
    }).returning({ id: workspaces.id })
    if (!row) throw new Error('failed to create workspace')
    createdWorkspaceIds.push(row.id)
    return row.id
}

async function insertTask(workspaceId: string): Promise<string> {
    const id = `phase-f1-${randomBytes(8).toString('hex')}`
    await db.insert(tasks).values({
        id,
        workspaceId,
        type: 'general',
        source: 'api',
        status: 'running',
        context: { phaseF1: true },
    })
    createdTaskIds.push(id)
    return id
}

function makeStep(n: number, isOneWayDoor = false): PlanStep {
    return {
        stepNumber: n,
        description: `step ${n}`,
        toolsRequired: [],
        verificationMethod: 'check',
        isOneWayDoor,
    }
}

function makePlan(taskId: string, steps: PlanStep[], owds: OneWayDoor[] = []): ExecutionPlan {
    return {
        taskId,
        goal: 'phase-f1 plan',
        steps,
        oneWayDoors: owds,
        estimatedDurationMs: 30_000,
        confidenceScore: 0.8,
        risks: [],
    }
}

/**
 * Subscribe to internal SSE events for the duration of a test. The unsubscribe
 * fn must be called in the test's finally so handlers don't leak across tests.
 */
function captureEvents(filter: (e: AgentEvent) => boolean): { events: AgentEvent[]; stop: () => void } {
    const events: AgentEvent[] = []
    const stop = onAgentEvent((e) => {
        if (filter(e)) events.push(e)
    })
    return { events, stop }
}

// Allow plan_proposed inserts a moment to land — recordTaskEvent is fire-and-
// forget inside emitPlanProposal (matches the prod call sites).
async function flushTaskEvents(): Promise<void> {
    await new Promise(r => setTimeout(r, 250))
}

beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set')
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

afterAll(() => {
    // No persistent connections to close — db pool is shared and torn down by setup.ts.
})

describe('Phase F1 — plan_proposal SSE', () => {
    describe('Suite 1 — emit gate', () => {
        it('plan with steps.length >= 3 and no OWD → emits plan_proposal with requiresApproval=false, approvalId=null', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask(workspaceId)
            const plan = makePlan(taskId, [makeStep(1), makeStep(2), makeStep(3)])

            const { events, stop } = captureEvents(e => e.type === 'plan_proposal' && e.taskId === taskId)
            try {
                const fired = emitPlanProposal({
                    workspaceId,
                    taskId,
                    plan,
                    requiresApproval: false,
                    approvalId: null,
                })
                expect(fired).toBe(true)
                expect(events).toHaveLength(1)
                const e = events[0]!
                expect(e.requiresApproval).toBe(false)
                expect(e.approvalId).toBeNull()
                const planPayload = e.plan as Record<string, unknown>
                expect(planPayload.goal).toBe('phase-f1 plan')
                expect((planPayload.steps as PlanStep[]).length).toBe(3)
                expect((planPayload.steps as PlanStep[])[0]!.stepNumber).toBe(1)
                expect((planPayload.oneWayDoors as OneWayDoor[]).length).toBe(0)
                expect(planPayload.confidenceScore).toBe(0.8)
            } finally {
                stop()
            }
        })

        it('plan with steps.length >= 3 and OWD → plan_proposal carries requiresApproval=true and the same approvalId requestApproval returned', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask(workspaceId)
            const owd: OneWayDoor = {
                description: 'destructive write',
                type: 'data_write',
                reversibility: 'irreversible',
                requiresApproval: true,
            }
            const plan = makePlan(
                taskId,
                [makeStep(1), makeStep(2), makeStep(3, true)],
                [owd],
            )

            const approval = await requestApproval({
                taskId,
                workspaceId,
                operation: 'data_write',
                description: owd.description,
                riskLevel: 'high',
            })
            expect(approval.id).toBeTruthy()

            const { events, stop } = captureEvents(e => e.type === 'plan_proposal' && e.taskId === taskId)
            try {
                const fired = emitPlanProposal({
                    workspaceId,
                    taskId,
                    plan,
                    requiresApproval: true,
                    approvalId: approval.id,
                })
                expect(fired).toBe(true)
                expect(events).toHaveLength(1)
                const e = events[0]!
                expect(e.requiresApproval).toBe(true)
                expect(e.approvalId).toBe(approval.id)
                const planPayload = e.plan as Record<string, unknown>
                expect((planPayload.steps as PlanStep[]).length).toBe(3)
                expect((planPayload.oneWayDoors as OneWayDoor[]).length).toBe(1)
                expect((planPayload.oneWayDoors as OneWayDoor[])[0]!.type).toBe('data_write')
            } finally {
                stop()
            }
        })

        it('plan with steps.length < 3 → NO plan_proposal event emitted (gate skips)', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask(workspaceId)
            const plan = makePlan(taskId, [makeStep(1), makeStep(2)])

            const { events, stop } = captureEvents(e => e.type === 'plan_proposal' && e.taskId === taskId)
            try {
                const fired = emitPlanProposal({
                    workspaceId,
                    taskId,
                    plan,
                    requiresApproval: false,
                    approvalId: null,
                })
                expect(fired).toBe(false)
                expect(events).toHaveLength(0)
            } finally {
                stop()
            }
        })
    })

    describe('Suite 2 — lifecycle event sink', () => {
        it('emit fires plan_proposed row in plexo_ops_task_events with planning→planning, metadata carries steps/confidence/requiresApproval/approvalId/oneWayDoors', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask(workspaceId)
            const plan = makePlan(taskId, [makeStep(1), makeStep(2), makeStep(3)])

            const fired = emitPlanProposal({
                workspaceId,
                taskId,
                plan,
                requiresApproval: false,
                approvalId: null,
            })
            expect(fired).toBe(true)
            await flushTaskEvents()

            const rows = await db.select().from(plexoOpsTaskEvents)
                .where(sql`${plexoOpsTaskEvents.taskId} = ${taskId} AND ${plexoOpsTaskEvents.eventType} = 'plan_proposed'`)
            expect(rows).toHaveLength(1)
            const r = rows[0]!
            expect(r.fromState).toBe('planning')
            expect(r.toState).toBe('planning')
            expect(r.metadata).toMatchObject({
                steps: 3,
                confidence: 0.8,
                requiresApproval: false,
                approvalId: null,
                oneWayDoors: 0,
            })
        })

        it('OWD path persists approvalId in plan_proposed metadata', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask(workspaceId)
            const owd: OneWayDoor = {
                description: 'schema migration',
                type: 'schema_migration',
                reversibility: 'irreversible',
                requiresApproval: true,
            }
            const plan = makePlan(
                taskId,
                [makeStep(1), makeStep(2), makeStep(3, true)],
                [owd],
            )

            const approval = await requestApproval({
                taskId,
                workspaceId,
                operation: 'schema_migration',
                description: owd.description,
                riskLevel: 'high',
            })

            emitPlanProposal({
                workspaceId,
                taskId,
                plan,
                requiresApproval: true,
                approvalId: approval.id,
            })
            await flushTaskEvents()

            const rows = await db.select().from(plexoOpsTaskEvents)
                .where(sql`${plexoOpsTaskEvents.taskId} = ${taskId} AND ${plexoOpsTaskEvents.eventType} = 'plan_proposed'`)
            expect(rows).toHaveLength(1)
            expect(rows[0]!.metadata).toMatchObject({
                requiresApproval: true,
                approvalId: approval.id,
                oneWayDoors: 1,
            })
        })

        it('plan with steps.length < 3 → NO plan_proposed row written', async () => {
            const workspaceId = await createWorkspace()
            const taskId = await insertTask(workspaceId)
            const plan = makePlan(taskId, [makeStep(1), makeStep(2)])

            const fired = emitPlanProposal({
                workspaceId,
                taskId,
                plan,
                requiresApproval: false,
                approvalId: null,
            })
            expect(fired).toBe(false)
            await flushTaskEvents()

            const rows = await db.select().from(plexoOpsTaskEvents)
                .where(sql`${plexoOpsTaskEvents.taskId} = ${taskId} AND ${plexoOpsTaskEvents.eventType} = 'plan_proposed'`)
            expect(rows).toHaveLength(0)
        })
    })
})
