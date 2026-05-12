/**
 * Queue integration tests — runs against the local dev Postgres.
 * DATABASE_URL is set in tests/setup.ts.
 *
 * These tests validate queue semantics end-to-end against a real DB.
 * Teardown removes all test workspace data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { push, complete, block, cancel, list } from '../../packages/queue/src/index.js'
import { db, eq, sql } from '@plexo/db'
import { workspaces, tasks } from '@plexo/db'

// Test workspace created once, cleaned up after all tests
let workspaceId: string
let userId: string

beforeAll(async () => {
    // Use timestamp-based unique ID compatible with UUID format for test isolation
    const ts = Date.now().toString(16).padEnd(8, '0')
    userId = `00000000-0000-4000-8000-${ts.padStart(12, '0')}`
    workspaceId = `00000000-0000-4000-9000-${ts.padStart(12, '0')}`

    const nowIso = new Date().toISOString()
    await db.execute(sql`
        INSERT INTO users (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
        VALUES (${userId}, 'Queue Integration Test User', ${`queue-test-${ts}@plexo.test`}, true, ${nowIso}::timestamptz, ${nowIso}::timestamptz, 'user')
        ON CONFLICT (id) DO NOTHING
    `).catch(() => { /* FDW may not be configured in test env */ })

    await db.insert(workspaces).values({
        id: workspaceId,
        name: 'Queue Integration Test Workspace',
        ownerId: userId,
        settings: {},
    }).onConflictDoNothing()
})

afterAll(async () => {
    await db.delete(tasks).where(eq(tasks.workspaceId, workspaceId)).catch(() => { })
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId)).catch(() => { })
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => { })
})

describe('queue — integration', () => {
    it('push creates a task and returns its ULID', async () => {
        const id = await push({
            workspaceId,
            type: 'research',
            source: 'api',
            context: { description: 'queue integration test' },
        })
        expect(id).toMatch(/^[0-9A-Z]{26}$/)
    })

    it('list returns queued tasks for the workspace', async () => {
        const id = await push({
            workspaceId,
            type: 'ops',
            source: 'api',
            context: { description: 'list test' },
        })
        const items = await list({ workspaceId, status: 'queued' })
        const found = items.find((t) => t.id === id)
        expect(found).toBeDefined()
        expect(found?.type).toBe('ops')
    })

    it('complete transitions task to complete with score', async () => {
        const id = await push({
            workspaceId,
            type: 'monitoring',
            source: 'cron',
            context: {},
        })
        await complete(id, {
            qualityScore: 0.95,
            outcomeSummary: 'Integration test complete',
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 0.001,
        })
        const completedItems = await list({ workspaceId, status: 'complete' })
        const task = completedItems.find((t) => t.id === id)
        expect(task).toBeDefined()
        expect(Number(task?.qualityScore)).toBeCloseTo(0.95, 2)
    })

    it('block transitions task to blocked status', async () => {
        const id = await push({ workspaceId, type: 'ops', source: 'api', context: {} })
        await block(id, 'No credential configured')
        const items = await list({ workspaceId, status: 'blocked' })
        expect(items.some((t) => t.id === id)).toBe(true)
    })

    it('cancel transitions task to cancelled status', async () => {
        const id = await push({ workspaceId, type: 'research', source: 'dashboard', context: {} })
        await cancel(id)
        const items = await list({ workspaceId, status: 'cancelled' })
        expect(items.some((t) => t.id === id)).toBe(true)
    })

    it('lower priority number = returned first in list', async () => {
        const lo = await push({ workspaceId, type: 'monitoring', source: 'api', context: {}, priority: 10 })
        const hi = await push({ workspaceId, type: 'monitoring', source: 'api', context: {}, priority: 1 })
        const items = await list({ workspaceId, status: 'queued', limit: 100 })
        const loIdx = items.findIndex((t) => t.id === lo)
        const hiIdx = items.findIndex((t) => t.id === hi)
        expect(hiIdx).toBeLessThan(loIdx)
    })
})
