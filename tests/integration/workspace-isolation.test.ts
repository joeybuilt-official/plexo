/**
 * Phase E: Multi-workspace isolation test suite.
 * Verifies that workspace A cannot access workspace B's data
 * across tasks, conversations, AI provider settings, SSE events, and agent rules.
 *
 * Runs against real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { push } from '../../packages/queue/src/index.js'
import { db, eq, sql } from '@plexo/db'
import { workspaces, users, tasks, conversations, behaviorRules } from '@plexo/db'

let userA: string
let userB: string
let workspaceA: string
let workspaceB: string

beforeAll(async () => {
    const ts = Date.now().toString(16).padEnd(8, '0')
    userA = `00000000-0000-4000-8000-${ts.padStart(12, '0')}`
    userB = `00000000-0000-4000-8001-${ts.padStart(12, '0')}`
    workspaceA = `00000000-0000-4000-b000-${ts.padStart(12, '0')}`
    workspaceB = `00000000-0000-4000-b001-${ts.padStart(12, '0')}`

    // Create two users and two workspaces
    await db.insert(users).values([
        { id: userA, email: `ws-iso-a-${ts}@plexo.test`, name: 'User A', role: 'member' },
        { id: userB, email: `ws-iso-b-${ts}@plexo.test`, name: 'User B', role: 'member' },
    ]).onConflictDoNothing()

    await db.insert(workspaces).values([
        { id: workspaceA, name: 'Isolation Test A', ownerId: userA, settings: {} },
        { id: workspaceB, name: 'Isolation Test B', ownerId: userB, settings: {} },
    ]).onConflictDoNothing()
})

afterAll(async () => {
    await db.delete(tasks).where(eq(tasks.workspaceId, workspaceA)).catch(() => {})
    await db.delete(tasks).where(eq(tasks.workspaceId, workspaceB)).catch(() => {})
    await db.delete(conversations).where(eq(conversations.workspaceId, workspaceA)).catch(() => {})
    await db.delete(conversations).where(eq(conversations.workspaceId, workspaceB)).catch(() => {})
    await db.execute(sql`DELETE FROM behavior_rules WHERE workspace_id = ${workspaceA}::uuid`).catch(() => {})
    await db.execute(sql`DELETE FROM behavior_rules WHERE workspace_id = ${workspaceB}::uuid`).catch(() => {})
    await db.delete(workspaces).where(eq(workspaces.id, workspaceA)).catch(() => {})
    await db.delete(workspaces).where(eq(workspaces.id, workspaceB)).catch(() => {})
    await db.delete(users).where(eq(users.id, userA)).catch(() => {})
    await db.delete(users).where(eq(users.id, userB)).catch(() => {})
})

describe('Task isolation', () => {
    it('workspace A tasks are not visible when querying workspace B', async () => {
        const taskA = await push({
            workspaceId: workspaceA,
            type: 'research',
            source: 'api',
            context: { description: 'workspace A task' },
        })

        const taskB = await push({
            workspaceId: workspaceB,
            type: 'ops',
            source: 'api',
            context: { description: 'workspace B task' },
        })

        // Query tasks for workspace A — should NOT contain taskB
        const rowsA = await db.select({ id: tasks.id })
            .from(tasks)
            .where(eq(tasks.workspaceId, workspaceA))

        const rowsB = await db.select({ id: tasks.id })
            .from(tasks)
            .where(eq(tasks.workspaceId, workspaceB))

        expect(rowsA.map(r => r.id)).toContain(taskA)
        expect(rowsA.map(r => r.id)).not.toContain(taskB)

        expect(rowsB.map(r => r.id)).toContain(taskB)
        expect(rowsB.map(r => r.id)).not.toContain(taskA)
    })
})

describe('Conversation isolation', () => {
    it('workspace A conversations do not appear in workspace B queries', async () => {
        const convAId = `conv-a-${Date.now()}`
        const convBId = `conv-b-${Date.now()}`

        await db.insert(conversations).values({
            id: convAId,
            workspaceId: workspaceA,
            source: 'dashboard',
            message: 'Hello from workspace A',
            reply: 'Response A',
            status: 'complete',
        })

        await db.insert(conversations).values({
            id: convBId,
            workspaceId: workspaceB,
            source: 'dashboard',
            message: 'Hello from workspace B',
            reply: 'Response B',
            status: 'complete',
        })

        // Query conversations for workspace B — should NOT contain convA
        const rowsB = await db.select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.workspaceId, workspaceB))

        const rowsA = await db.select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.workspaceId, workspaceA))

        expect(rowsB.map(r => r.id)).toContain(convBId)
        expect(rowsB.map(r => r.id)).not.toContain(convAId)

        expect(rowsA.map(r => r.id)).toContain(convAId)
        expect(rowsA.map(r => r.id)).not.toContain(convBId)
    })
})

describe('AI provider settings isolation', () => {
    it('workspace A AI provider keys are not accessible from workspace B', async () => {
        // Store AI provider config in workspace A settings
        await db.update(workspaces)
            .set({ settings: { vault: { openai: { apiKey: 'sk-test-workspace-a' } }, arbiter: { primaryProvider: 'openai' } } })
            .where(eq(workspaces.id, workspaceA))

        await db.update(workspaces)
            .set({ settings: { vault: { anthropic: { apiKey: 'sk-test-workspace-b' } }, arbiter: { primaryProvider: 'anthropic' } } })
            .where(eq(workspaces.id, workspaceB))

        // Fetch workspace A settings
        const [wsA] = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceA))

        // Fetch workspace B settings
        const [wsB] = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceB))

        const settingsA = wsA!.settings as Record<string, unknown>
        const settingsB = wsB!.settings as Record<string, unknown>

        // Workspace A should have openai, not anthropic
        const vaultA = settingsA.vault as Record<string, { apiKey?: string }>
        expect(vaultA.openai?.apiKey).toBe('sk-test-workspace-a')
        expect(vaultA.anthropic).toBeUndefined()

        // Workspace B should have anthropic, not openai
        const vaultB = settingsB.vault as Record<string, { apiKey?: string }>
        expect(vaultB.anthropic?.apiKey).toBe('sk-test-workspace-b')
        expect(vaultB.openai).toBeUndefined()
    })
})

describe('Behavior rules isolation', () => {
    it('workspace A rules do not appear in workspace B queries', async () => {
        // Insert a rule for workspace A
        await db.insert(behaviorRules).values({
            workspaceId: workspaceA,
            type: 'operational_rule',
            key: 'test-iso-rule',
            label: 'Test isolation rule',
            description: 'Always use TypeScript strict mode',
            value: { type: 'boolean', value: true },
            source: 'workspace',
        }).onConflictDoNothing()

        // Query rules for workspace B — should be empty
        const rulesB = await db.select()
            .from(behaviorRules)
            .where(eq(behaviorRules.workspaceId, workspaceB))

        const rulesA = await db.select()
            .from(behaviorRules)
            .where(eq(behaviorRules.workspaceId, workspaceA))

        expect(rulesB.length).toBe(0)
        expect(rulesA.length).toBeGreaterThanOrEqual(1)
        expect(rulesA.some(r => r.key === 'test-iso-rule')).toBe(true)
    })
})

describe('SSE isolation', () => {
    it('emitToWorkspace only delivers to clients registered for that workspace', async () => {
        // Import SSE emitter (unit-level validation of the isolation mechanism)
        const { registerClient, unregisterClient, emitToWorkspace } = await import('../../apps/api/src/sse-emitter.js')

        const receivedA: string[] = []
        const receivedB: string[] = []

        // Mock Response objects
        const mockResA = {
            write: (data: string) => { receivedA.push(data); return true },
        }
        const mockResB = {
            write: (data: string) => { receivedB.push(data); return true },
        }

        const clientIdA = registerClient(workspaceA, mockResA as any)
        const clientIdB = registerClient(workspaceB, mockResB as any)

        // Emit event to workspace A only
        emitToWorkspace(workspaceA, { type: 'task_queued', taskId: 'task-a-1' })

        // Emit event to workspace B only
        emitToWorkspace(workspaceB, { type: 'task_queued', taskId: 'task-b-1' })

        // Client A should have received workspace A event, not B
        expect(receivedA.length).toBe(1)
        expect(receivedA[0]).toContain('task-a-1')
        expect(receivedA[0]).not.toContain('task-b-1')

        // Client B should have received workspace B event, not A
        expect(receivedB.length).toBe(1)
        expect(receivedB[0]).toContain('task-b-1')
        expect(receivedB[0]).not.toContain('task-a-1')

        // Cleanup
        unregisterClient(workspaceA, clientIdA)
        unregisterClient(workspaceB, clientIdB)
    })
})

describe('Workspace data cascade', () => {
    it('deleting a workspace cascades to its tasks', async () => {
        // Create a temporary workspace with a task
        const tempWsId = `00000000-0000-4000-b002-${Date.now().toString(16).padStart(12, '0')}`
        await db.insert(workspaces).values({
            id: tempWsId, name: 'Temp Cascade Test', ownerId: userA, settings: {},
        })
        const taskId = await push({
            workspaceId: tempWsId,
            type: 'general',
            source: 'api',
            context: { description: 'cascade test' },
        })

        // Verify task exists
        const [before] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))
        expect(before).toBeTruthy()

        // Delete workspace — task should cascade
        await db.delete(workspaces).where(eq(workspaces.id, tempWsId))

        const [after] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))
        expect(after).toBeUndefined()
    })
})
