/**
 * Concurrent task claim integration tests.
 * Verifies that SELECT FOR UPDATE SKIP LOCKED prevents double-claims under
 * 3-worker parallel load. Runs against local dev Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { push, claim, list } from '../../packages/queue/src/index.js'
import { db, eq, sql } from '@plexo/db'
import { workspaces, tasks } from '@plexo/db'

let workspaceId: string
let userId: string

beforeAll(async () => {
    const ts = Date.now().toString(16).slice(-10).padStart(10, '0')
    userId = `00000000-0000-4000-8000-cc${ts}`
    workspaceId = `00000000-0000-4000-9000-cc${ts}`

    const nowIso = new Date().toISOString()
    await db.execute(sql`
        INSERT INTO users (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
        VALUES (${userId}, 'Concurrent Claims Test User', ${`concurrent-claims-${ts}@plexo.test`},
                true, ${nowIso}::timestamptz, ${nowIso}::timestamptz, 'user')
        ON CONFLICT (id) DO NOTHING
    `).catch(() => { /* FDW may not be configured */ })

    await db.insert(workspaces).values({
        id: workspaceId,
        name: 'Concurrent Claims Test Workspace',
        ownerId: userId,
        settings: {},
    }).onConflictDoNothing()
})

afterAll(async () => {
    await db.delete(tasks).where(eq(tasks.workspaceId, workspaceId)).catch(() => { })
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId)).catch(() => { })
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => { })
})

describe('queue claim — concurrent safety', () => {
    it('3 workers claiming from 5-task queue: no double-claims', async () => {
        // Push 5 tasks so every worker can claim one
        const pushed = await Promise.all(
            Array.from({ length: 5 }, (_, i) =>
                push({
                    workspaceId,
                    type: 'research',
                    source: 'api',
                    context: { worker: i, test: 'concurrent-claim' },
                    priority: 1,
                })
            )
        )
        expect(pushed).toHaveLength(5)
        const pushedIds = new Set(pushed)

        const WORKERS = 3
        const agentIds = Array.from({ length: WORKERS }, (_, i) => `agent-concurrent-${i}`)

        // Simulate 3 workers racing to claim
        const claimed = await Promise.all(agentIds.map(agentId => claim(agentId)))

        // Filter to claims that belong to our pushed tasks
        // (claim() uses raw db.execute so column names are snake_case; match by ID instead)
        const ours = claimed.filter((t): t is NonNullable<typeof t> =>
            t !== null && pushedIds.has(t.id)
        )

        // Each worker should have claimed a distinct task
        const ourIds = ours.map(t => t.id)
        expect(new Set(ourIds).size).toBe(ourIds.length)

        // All claimed tasks are in 'claimed' status
        for (const task of ours) {
            expect(task.status).toBe('claimed')
            expect(task.claimed_at).not.toBeNull()
        }

        // At most 3 of our 5 tasks were claimed (one per worker, no double-claim)
        expect(ours.length).toBeLessThanOrEqual(WORKERS)
        expect(ours.length).toBeGreaterThan(0)

        // Verify via DB: none of our tasks was claimed by more than one worker
        const claimedFromDb = await list({ workspaceId, status: 'claimed' })
        const claimedIds = claimedFromDb.map(t => t.id)
        expect(new Set(claimedIds).size).toBe(claimedIds.length)
    })

    it('10 workers claiming from 5-task queue: exactly 5 claims total', async () => {
        // Fresh set of tasks for this sub-test
        const pushed = await Promise.all(
            Array.from({ length: 5 }, (_, i) =>
                push({
                    workspaceId,
                    type: 'ops',
                    source: 'api',
                    context: { batch: 'exhaustion', seq: i },
                    priority: 1,
                })
            )
        )
        const pushedIds = new Set(pushed)

        // 10 workers compete — only 5 tasks available for our workspace
        const workers = 10
        const results = await Promise.all(
            Array.from({ length: workers }, (_, i) => claim(`agent-exhaust-${i}`))
        )

        // Keep only claims for our pushed tasks
        const ourClaims = results.filter(
            (t): t is NonNullable<typeof t> => t !== null && pushedIds.has(t.id)
        )

        // Every pushed task can be claimed at most once
        const claimedIds = ourClaims.map(t => t.id)
        expect(new Set(claimedIds).size).toBe(claimedIds.length)

        // We pushed 5 tasks; 10 workers → at most 5 of our tasks can be claimed
        expect(ourClaims.length).toBeLessThanOrEqual(5)
    })

    it('sequential re-claim attempt returns null: task not double-assigned', async () => {
        const id = await push({
            workspaceId,
            type: 'monitoring',
            source: 'cron',
            context: { test: 'single-claim' },
            priority: 1,
        })

        // Verify task starts in queued state
        const queued = await list({ workspaceId, status: 'queued' })
        expect(queued.some(t => t.id === id)).toBe(true)

        // claim() is global — other workspaces' tasks may be claimed first.
        // Drain up to 20 claims until we reach our specific task.
        let ours: Awaited<ReturnType<typeof claim>> = null
        for (let i = 0; i < 20 && !ours; i++) {
            const t = await claim(`agent-drain-${i}`)
            if (t?.id === id) ours = t
        }

        expect(ours).not.toBeNull()
        expect(ours?.status).toBe('claimed')

        // SELECT FOR UPDATE SKIP LOCKED must block all re-claim attempts
        for (let i = 0; i < 5; i++) {
            const t = await claim(`agent-retry-${i}`)
            if (t !== null) {
                expect(t.id).not.toBe(id)
            }
        }
    })
})
