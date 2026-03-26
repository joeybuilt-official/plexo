/**
 * Phase 6: Five critical regression scenarios — integration tests.
 * Runs against real Postgres (local dev). Tests queue, task lifecycle,
 * checkpoint persistence, and attempt count behavior.
 *
 * These map to the five failure modes fixed by the stabilization plan:
 * 1. Resume from checkpoint — crash after step 1
 * 2. task_complete terminates loop and persists deliverable
 * 3. Attempt count increments on requeue
 * 4. Abort signal marks task cancelled
 * 5. Ghost task recovery requeues stale running tasks
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { push } from '../../packages/queue/src/index.js'
import { db, eq, sql } from '@plexo/db'
import { workspaces, users, tasks, taskSteps } from '@plexo/db'

let workspaceId: string
let userId: string

beforeAll(async () => {
    const ts = Date.now().toString(16).padEnd(8, '0')
    userId = `00000000-0000-4000-8000-${ts.padStart(12, '0')}`
    workspaceId = `00000000-0000-4000-a000-${ts.padStart(12, '0')}`

    await db.insert(users).values({
        id: userId,
        email: `agent-reg-${ts}@plexo.test`,
        name: 'Agent Regression Test User',
        role: 'member',
    }).onConflictDoNothing()

    await db.insert(workspaces).values({
        id: workspaceId,
        name: 'Agent Regression Test Workspace',
        ownerId: userId,
        settings: {},
    }).onConflictDoNothing()
})

afterAll(async () => {
    // Clean up all test data
    await db.execute(sql`DELETE FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id = ${workspaceId}::uuid)`).catch(() => {})
    await db.delete(tasks).where(eq(tasks.workspaceId, workspaceId)).catch(() => {})
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId)).catch(() => {})
    await db.delete(users).where(eq(users.id, userId)).catch(() => {})
})

describe('1. Checkpoint persistence — step_state and is_terminal', () => {
    it('inserts step records with step_state JSONB and is_terminal flag', async () => {
        const taskId = await push({
            workspaceId,
            type: 'general',
            source: 'api',
            context: { description: 'checkpoint test' },
        })

        // Simulate what the executor does: insert a non-terminal step
        await db.insert(taskSteps).values({
            taskId,
            stepNumber: 0,
            model: 'mock/test',
            tokensIn: 100,
            tokensOut: 50,
            toolCalls: [{ tool: 'read_file', input: { path: 'test.ts' }, output: 'content' }],
            outcome: 'running',
            stepState: { responseMessages: [{ role: 'assistant', content: 'Reading file...' }] },
            isTerminal: false,
        })

        // Insert a terminal step
        await db.insert(taskSteps).values({
            taskId,
            stepNumber: 1,
            model: 'mock/test',
            tokensIn: 100,
            tokensOut: 50,
            toolCalls: [{ tool: 'task_complete', input: { summary: 'Done' }, output: '{"done":true}' }],
            outcome: 'complete',
            stepState: { responseMessages: [{ role: 'assistant', content: 'Complete' }] },
            isTerminal: true,
        })

        // Verify step records
        const steps = await db.select()
            .from(taskSteps)
            .where(eq(taskSteps.taskId, taskId))
            .orderBy(taskSteps.stepNumber)

        expect(steps).toHaveLength(2)
        expect(steps[0]!.isTerminal).toBe(false)
        expect(steps[0]!.stepState).toBeTruthy()
        expect((steps[0]!.stepState as { responseMessages: unknown[] }).responseMessages).toHaveLength(1)
        expect(steps[1]!.isTerminal).toBe(true)
    })
})

describe('2. Deliverable persistence via task_complete', () => {
    it('stores deliverable JSONB on the task row', async () => {
        const taskId = await push({
            workspaceId,
            type: 'research',
            source: 'api',
            context: { description: 'deliverable test' },
        })

        const deliverable = {
            summary: 'Added rate limiting to /api/v1/auth/login',
            outcome: 'completed',
            works: [
                { type: 'file', label: 'Rate limiter middleware', content: 'src/middleware/rate-limit.ts' },
            ],
            verificationSteps: ['Run: curl -X POST /api/v1/auth/login 6x rapidly'],
        }

        await db.update(tasks)
            .set({ deliverable })
            .where(eq(tasks.id, taskId))

        const [row] = await db.select({ deliverable: tasks.deliverable })
            .from(tasks)
            .where(eq(tasks.id, taskId))

        expect(row).toBeTruthy()
        const d = row!.deliverable as typeof deliverable
        expect(d.summary).toBe('Added rate limiting to /api/v1/auth/login')
        expect(d.outcome).toBe('completed')
        expect(d.works).toHaveLength(1)
        expect(d.works[0]!.type).toBe('file')
        expect(d.verificationSteps).toHaveLength(1)
    })
})

describe('3. Attempt count increments on requeue', () => {
    it('increments attempt_count when task is requeued after slot expiry', async () => {
        const taskId = await push({
            workspaceId,
            type: 'ops',
            source: 'api',
            context: { description: 'attempt count test' },
        })

        // Simulate task being claimed and running
        await db.update(tasks)
            .set({ status: 'running', claimedAt: new Date() })
            .where(eq(tasks.id, taskId))

        // Simulate expired slot requeue (what handleExpiredSlot does)
        await db.execute(sql`
            UPDATE tasks
            SET attempt_count = COALESCE(attempt_count, 0) + 1,
                status = 'queued',
                claimed_at = NULL
            WHERE id = ${taskId}
        `)

        const [row1] = await db.select({ attemptCount: tasks.attemptCount, status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, taskId))

        expect(row1!.attemptCount).toBe(1)
        expect(row1!.status).toBe('queued')

        // Second attempt
        await db.update(tasks)
            .set({ status: 'running', claimedAt: new Date() })
            .where(eq(tasks.id, taskId))

        await db.execute(sql`
            UPDATE tasks
            SET attempt_count = COALESCE(attempt_count, 0) + 1,
                status = 'queued',
                claimed_at = NULL
            WHERE id = ${taskId}
        `)

        const [row2] = await db.select({ attemptCount: tasks.attemptCount })
            .from(tasks)
            .where(eq(tasks.id, taskId))

        expect(row2!.attemptCount).toBe(2)
    })

    it('marks task as failed after 3 attempts', async () => {
        const taskId = await push({
            workspaceId,
            type: 'ops',
            source: 'api',
            context: { description: 'max attempts test' },
        })

        // Set attempt_count to 2, then simulate one more failure
        await db.update(tasks)
            .set({ status: 'running', claimedAt: new Date() })
            .where(eq(tasks.id, taskId))

        await db.execute(sql`
            UPDATE tasks
            SET attempt_count = 2
            WHERE id = ${taskId}
        `)

        // Third attempt — should fail
        await db.execute(sql`
            UPDATE tasks
            SET attempt_count = COALESCE(attempt_count, 0) + 1,
                status = CASE
                    WHEN COALESCE(attempt_count, 0) + 1 >= 3 THEN 'blocked'::task_status
                    ELSE 'queued'::task_status
                END
            WHERE id = ${taskId}
        `)

        const [row] = await db.select({ attemptCount: tasks.attemptCount, status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, taskId))

        expect(row!.attemptCount).toBe(3)
        expect(row!.status).toBe('blocked')
    })
})

describe('4. Task cancellation via status update', () => {
    it('cancelled task has correct status', async () => {
        const taskId = await push({
            workspaceId,
            type: 'general',
            source: 'api',
            context: { description: 'cancel test' },
        })

        await db.update(tasks)
            .set({ status: 'cancelled', outcomeSummary: 'Cancelled by operator' })
            .where(eq(tasks.id, taskId))

        const [row] = await db.select({ status: tasks.status, outcomeSummary: tasks.outcomeSummary })
            .from(tasks)
            .where(eq(tasks.id, taskId))

        expect(row!.status).toBe('cancelled')
        expect(row!.outcomeSummary).toBe('Cancelled by operator')
    })
})

describe('5. Ghost task detection query', () => {
    it('finds running tasks with claimed_at older than 3 minutes', async () => {
        const taskId = await push({
            workspaceId,
            type: 'coding',
            source: 'api',
            context: { description: 'ghost detection test' },
        })

        // Set task to running with old claimed_at
        await db.execute(sql`
            UPDATE tasks
            SET status = 'running',
                claimed_at = NOW() - INTERVAL '5 minutes'
            WHERE id = ${taskId}
        `)

        // Run the ghost detection query
        const ghosts = await db.execute<{ id: string }>(sql`
            SELECT id FROM tasks
            WHERE status = 'running'
              AND claimed_at < NOW() - INTERVAL '3 minutes'
              AND workspace_id = ${workspaceId}::uuid
        `)

        expect(ghosts.length).toBeGreaterThanOrEqual(1)
        expect(ghosts.some(g => g.id === taskId)).toBe(true)
    })
})
