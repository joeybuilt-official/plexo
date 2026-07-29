// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 4.5.2 — Confirmation flow end-to-end.
 *
 * The Phase 4 channel confirmation surface is `handleInboundConfirmCancel`
 * in apps/api/src/channel-delivery.ts. A user replies CONFIRM/CANCEL in
 * telegram/slack/discord; the handler matches the most-recent
 * awaiting_approval task in the workspace whose channelRef points at the
 * inbound chat, looks up `tasks.context._approvalId`, and resolves the OWD
 * record via the same pipeline the dashboard uses.
 *
 * Like `confirm-gate.integration.test.ts`, this suite does NOT spin up the
 * full agent-loop — that requires LLM credentials and is brittle. Each
 * test pre-stages the awaiting_approval state the agent-loop would have
 * produced (task row + OWD record + `_approvalId` in context), then
 * exercises the inbound path against real Postgres + Redis.
 *
 * What we assert:
 *   1. CONFIRM reply → handler returns `outcome:'approved'`, the OWD record
 *      flips to `decision:'approved'` (this is the signal the agent-loop's
 *      `waitForDecision` is polling for).
 *   2. CANCEL reply → handler returns `outcome:'cancelled'`, OWD flips to
 *      `decision:'rejected'`.
 *   3. Reply containing a 6-char code that DOES NOT match any pending
 *      approval for the chat → handler returns `outcome:'expired'` and the
 *      OWD record stays `decision:'pending'` (no accidental cross-task
 *      confirmation).
 *
 * The downstream "task reaches complete/failed and TASK_COMPLETED /
 * TASK_FAILED is published" behavior is the agent-loop's job after
 * `waitForDecision` returns. That side is already covered by
 * `confirm-gate.integration.test.ts` Suites 1+3 (waitForDecision returns
 * approved/rejected/timeout) and Phase 2's terminal-fail unit tests.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — direct path import; the workspace symlink doesn't expose `redis` as a bare specifier.
import { createClient, type RedisClientType } from '../../apps/api/node_modules/redis/dist/index.js'
import {
    db,
    sql,
    eq,
    tasks,
    workspaces,
    plexoOpsTaskEvents,
} from '@plexo/db'
import {
    requestApproval,
    getDecision,
} from '../../packages/agent/src/one-way-door.js'
import { handleInboundConfirmCancel } from '../../apps/api/src/channel-delivery.js'

const createdTaskIds: string[] = []
const createdWorkspaceIds: string[] = []
const createdUserIds: string[] = []

let testRedis: RedisClientType | null = null

async function getTestRedis(): Promise<RedisClientType> {
    if (!testRedis) {
        testRedis = createClient({ url: process.env.REDIS_URL }) as RedisClientType
        await testRedis.connect()
    }
    return testRedis
}

/**
 * Mark an OWD as SSE-delivered the way the production dashboard route does.
 * Without this, the agent-loop's `waitForDecision` would block ~60s in
 * pollForDeliveryAck before the actual decision is checked. This test only
 * asserts on the OWD record state directly (no waitForDecision call), so
 * the ack is precautionary in case waitForDecision-driven extensions are
 * added later.
 */
async function setDeliveryAck(taskId: string): Promise<void> {
    const r = await getTestRedis()
    await r.setEx(`owd:${taskId}:ack`, 600, '1')
}

async function createUser(): Promise<string> {
    const id = randomUUID()
    const email = `phase-4-5-${id}@example.test`
    await db.execute(sql`
        INSERT INTO users (id, email, role, created_at)
        VALUES (${id}::uuid, ${email}, 'member'::user_role, NOW())
    `)
    createdUserIds.push(id)
    return id
}

async function createWorkspace(settings: Record<string, unknown> = {}): Promise<string> {
    const ownerId = await createUser()
    const [row] = await db.insert(workspaces).values({
        name: `phase-4-5-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        ownerId,
        settings,
    }).returning({ id: workspaces.id })
    if (!row) throw new Error('failed to create workspace')
    createdWorkspaceIds.push(row.id)
    return row.id
}

interface AwaitingTaskParams {
    workspaceId: string
    channel: 'telegram' | 'slack' | 'discord'
    chatId: string
    approvalId: string
}

async function insertAwaitingTask(p: AwaitingTaskParams): Promise<string> {
    const id = `phase-4-5-${randomBytes(8).toString('hex')}`
    await db.insert(tasks).values({
        id,
        workspaceId: p.workspaceId,
        type: 'general',
        source: 'api',
        status: 'awaiting_approval',
        // Channel + approval id shape produced by agent-loop when it
        // transitions to awaiting_approval (see Phase 4 close notes).
        context: {
            channel: p.channel,
            chatId: p.chatId,
            description: 'phase-4-5 integration test',
            _approvalId: p.approvalId,
        },
        attemptCount: 0,
    })
    createdTaskIds.push(id)
    return id
}

beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set')
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL must be set')
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
    if (testRedis) {
        try { await testRedis.quit() } catch { /* ignore */ }
        testRedis = null
    }
})

describe('Phase 4.5.2 — channel confirmation reply flow', () => {
    it('CONFIRM reply resolves the OWD record to approved', async () => {
        const workspaceId = await createWorkspace()
        const chatId = `4501-${randomBytes(4).toString('hex')}`

        // Pre-stage what the agent-loop would have written: an awaiting_approval
        // task with the OWD approval id in context, and a pending OWD record.
        // Insert the task first with a placeholder, then patch _approvalId in
        // since requestApproval needs a real taskId in the DB.
        const taskId = await insertAwaitingTask({
            workspaceId,
            channel: 'telegram',
            chatId,
            approvalId: 'placeholder',
        })

        const approval = await requestApproval({
            taskId,
            workspaceId,
            operation: 'integration_confirm_' + randomBytes(4).toString('hex'),
            description: 'integration test — confirm path',
            riskLevel: 'medium',
        })
        await db.update(tasks).set({
            context: {
                channel: 'telegram',
                chatId,
                description: 'phase-4-5 integration test',
                _approvalId: approval.id,
            },
        }).where(eq(tasks.id, taskId))
        await setDeliveryAck(taskId)

        const result = await handleInboundConfirmCancel({
            workspaceId,
            channel: 'telegram',
            chatId,
            text: 'CONFIRM',
            decidedBy: 'integration-test@example.test',
        })

        expect(result.outcome).toBe('approved')
        expect(result.taskId).toBe(taskId)
        expect(result.approvalId).toBe(approval.id)

        // OWD record flipped — this is the state waitForDecision is polling for.
        const after = await getDecision(approval.id)
        expect(after).not.toBeNull()
        expect(after!.decision).toBe('approved')
        expect(after!.decidedBy).toBe('integration-test@example.test')
    })

    it('CANCEL reply resolves the OWD record to rejected', async () => {
        const workspaceId = await createWorkspace()
        const chatId = `4502-${randomBytes(4).toString('hex')}`

        const taskId = await insertAwaitingTask({
            workspaceId,
            channel: 'telegram',
            chatId,
            approvalId: 'placeholder',
        })

        const approval = await requestApproval({
            taskId,
            workspaceId,
            operation: 'integration_cancel_' + randomBytes(4).toString('hex'),
            description: 'integration test — cancel path',
            riskLevel: 'medium',
        })
        await db.update(tasks).set({
            context: {
                channel: 'telegram',
                chatId,
                description: 'phase-4-5 integration test',
                _approvalId: approval.id,
            },
        }).where(eq(tasks.id, taskId))
        await setDeliveryAck(taskId)

        const result = await handleInboundConfirmCancel({
            workspaceId,
            channel: 'telegram',
            chatId,
            text: 'CANCEL',
            decidedBy: 'integration-test@example.test',
        })

        expect(result.outcome).toBe('cancelled')
        expect(result.taskId).toBe(taskId)
        expect(result.approvalId).toBe(approval.id)

        const after = await getDecision(approval.id)
        expect(after).not.toBeNull()
        expect(after!.decision).toBe('rejected')
        expect(after!.decidedBy).toBe('integration-test@example.test')
    })

    it('CONFIRM with a code mismatch returns expired and leaves the OWD pending', async () => {
        const workspaceId = await createWorkspace()
        const chatId = `4503-${randomBytes(4).toString('hex')}`

        const taskId = await insertAwaitingTask({
            workspaceId,
            channel: 'telegram',
            chatId,
            approvalId: 'placeholder',
        })

        const approval = await requestApproval({
            taskId,
            workspaceId,
            operation: 'integration_mismatch_' + randomBytes(4).toString('hex'),
            description: 'integration test — code mismatch path',
            riskLevel: 'medium',
        })
        await db.update(tasks).set({
            context: {
                channel: 'telegram',
                chatId,
                description: 'phase-4-5 integration test',
                _approvalId: approval.id,
            },
        }).where(eq(tasks.id, taskId))
        await setDeliveryAck(taskId)

        // Build a 6-char hex code guaranteed not to be the prefix of approval.id.
        const realPrefix = approval.id.slice(0, 6).toLowerCase()
        const wrongCode = realPrefix === '000000' ? 'ffffff' : '000000'

        const result = await handleInboundConfirmCancel({
            workspaceId,
            channel: 'telegram',
            chatId,
            text: `CONFIRM ${wrongCode}`,
            decidedBy: 'integration-test@example.test',
        })

        expect(result.outcome).toBe('expired')

        // OWD record untouched — the wrong code should not flip a different task.
        const after = await getDecision(approval.id)
        expect(after).not.toBeNull()
        expect(after!.decision).toBe('pending')

        // Task row also untouched.
        const [taskRow] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
        expect(taskRow?.status).toBe('awaiting_approval')
    })

    it('CONFIRM with the matching 6-char code resolves the right approval when multiple pending', async () => {
        // Disambiguation guarantee: when two awaiting_approval tasks exist for
        // the same chat, the supplied code picks the matching one.
        const workspaceId = await createWorkspace()
        const chatId = `4504-${randomBytes(4).toString('hex')}`

        const taskA = await insertAwaitingTask({ workspaceId, channel: 'telegram', chatId, approvalId: 'pa' })
        const taskB = await insertAwaitingTask({ workspaceId, channel: 'telegram', chatId, approvalId: 'pb' })

        const approvalA = await requestApproval({
            taskId: taskA, workspaceId,
            operation: 'integration_disA_' + randomBytes(4).toString('hex'),
            description: 'A', riskLevel: 'medium',
        })
        const approvalB = await requestApproval({
            taskId: taskB, workspaceId,
            operation: 'integration_disB_' + randomBytes(4).toString('hex'),
            description: 'B', riskLevel: 'medium',
        })

        await db.update(tasks).set({
            context: { channel: 'telegram', chatId, description: 'A', _approvalId: approvalA.id },
        }).where(eq(tasks.id, taskA))
        await db.update(tasks).set({
            context: { channel: 'telegram', chatId, description: 'B', _approvalId: approvalB.id },
        }).where(eq(tasks.id, taskB))
        await setDeliveryAck(taskA)
        await setDeliveryAck(taskB)

        // Reply with B's code. A must remain pending; B flips to approved.
        const codeB = approvalB.id.slice(0, 6)
        const result = await handleInboundConfirmCancel({
            workspaceId,
            channel: 'telegram',
            chatId,
            text: `CONFIRM ${codeB}`,
            decidedBy: 'integration-test@example.test',
        })

        expect(result.outcome).toBe('approved')
        expect(result.approvalId).toBe(approvalB.id)
        expect(result.taskId).toBe(taskB)

        const afterA = await getDecision(approvalA.id)
        const afterB = await getDecision(approvalB.id)
        expect(afterA?.decision).toBe('pending')
        expect(afterB?.decision).toBe('approved')
    })

    it('reply that is not CONFIRM/CANCEL returns not_a_command', async () => {
        const workspaceId = await createWorkspace()
        const chatId = `4505-${randomBytes(4).toString('hex')}`
        const result = await handleInboundConfirmCancel({
            workspaceId,
            channel: 'telegram',
            chatId,
            text: 'just chatting about the weather',
            decidedBy: 'integration-test@example.test',
        })
        expect(result.outcome).toBe('not_a_command')
    })

    it('CONFIRM with no awaiting task for the chat returns no_pending', async () => {
        const workspaceId = await createWorkspace()
        const chatId = `4506-${randomBytes(4).toString('hex')}`
        const result = await handleInboundConfirmCancel({
            workspaceId,
            channel: 'telegram',
            chatId,
            text: 'CONFIRM',
            decidedBy: 'integration-test@example.test',
        })
        expect(result.outcome).toBe('no_pending')
    })
})
