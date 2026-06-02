// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 5 of intelligence-hardening — task debug viewer route tests.
 *
 * Pins:
 *   1. Happy path: valid task + member caller → rows + total + truncated:false
 *   2. 404 on unknown taskId
 *   3. 403 on non-member caller (ensureTaskWorkspaceAccess denies)
 *   4. Truncation: >200 rows returned → first 200 + truncated:true
 *
 * Follows the same mock-the-router pattern as `scl-attractors.test.ts`:
 * the `@plexo/db` module is mocked at test-setup time so the route's
 * `db.select(...).from(taskSteps).where(...).orderBy(...).limit(200)`
 * chain is intercepted by a stateful fake builder.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Mutable test state (reset in beforeEach) ─────────────────────────

const ctl = {
    /** Rows the fake `task_steps` SELECT chain will return. */
    stepRows: [] as Array<{
        stepNumber: number
        toolCalls: unknown
        stepState: unknown
        createdAt: Date
    }>,
    /** The workspace id the fake `tasks` row lookup should resolve to. null = 404. */
    taskWorkspaceId: 'ws-1' as string | null,
    /** Whether ensureTaskWorkspaceAccess (inside tasks.ts) should allow the request. */
    allowWorkspaceAccess: true,
}

// ── Mocks ────────────────────────────────────────────────────────────

// Fake Drizzle builder chain. `tasks.ts:ensureTaskWorkspaceAccess` calls
// `db.select({workspaceId:...}).from(tasks).where(...).limit(1)` to resolve
// the task's workspaceId. The Phase-5 route then calls
// `db.select({...}).from(taskSteps).where(...).orderBy(...).limit(200)` to
// fetch the rows. We distinguish the two calls by which mock table is
// passed to `.from()`.

vi.mock('@plexo/db', () => {
    // Placeholder sentinel tables the route code imports.
    const tasksSentinel = { __table: 'tasks', id: 'id', workspaceId: 'workspace_id' }
    const taskStepsSentinel = {
        __table: 'task_steps',
        taskId: 'task_id',
        stepNumber: 'step_number',
        toolCalls: 'tool_calls',
        stepState: 'step_state',
        createdAt: 'created_at',
    }
    const artifactsSentinel = { __table: 'artifacts', id: 'id', taskId: 'task_id', meta: 'meta', updatedAt: 'updated_at', filename: 'filename', type: 'type', kind: 'kind', currentVersion: 'current_version' }
    const artifactVersionsSentinel = { __table: 'artifact_versions', artifactId: 'artifact_id', version: 'version', content: 'content', changeDescription: 'change_description', createdAt: 'created_at' }

    function makeBuilder(table: unknown): any {
        const state = { table }
        return {
            from(t: unknown) { state.table = t; return this },
            where() { return this },
            orderBy() { return this },
            async limit(_n: number) {
                if (state.table === taskStepsSentinel) {
                    return ctl.stepRows
                }
                if (state.table === tasksSentinel) {
                    if (ctl.taskWorkspaceId === null) return []
                    return [{ workspaceId: ctl.taskWorkspaceId }]
                }
                return []
            },
            // For chains that call .innerJoin / .returning — not used here but
            // the tasks router has other routes that import this module.
            innerJoin() { return this },
            returning() { return [] },
            update() { return this },
            set() { return this },
            insert() { return this },
            values() { return this },
            onConflictDoUpdate() { return this },
        }
    }

    return {
        db: {
            select: (_fields?: unknown) => makeBuilder(undefined),
            execute: vi.fn(async () => []),
            update: (_t: unknown) => makeBuilder(undefined),
            insert: (_t: unknown) => makeBuilder(undefined),
        },
        tasks: tasksSentinel,
        taskSteps: taskStepsSentinel,
        artifacts: artifactsSentinel,
        artifactVersions: artifactVersionsSentinel,
        inferKind: vi.fn(() => ({ kind: 'doc', language: null })),
        eq: vi.fn(),
        and: vi.fn(),
        desc: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

// ensureTaskWorkspaceAccess in tasks.ts looks up the workspaceId from db
// (above mock covers it) and then delegates to ensureWorkspaceAccess from
// workspace-access.js for the actual membership check. Toggle it here.
vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async (_req: any, res: any, _ws: string) => {
        if (!ctl.allowWorkspaceAccess) {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You are not a member of this workspace' } })
            return false
        }
        return true
    }),
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
    resolveWorkspaceId: () => null,
}))

// Silence the rest of the router's dependency graph.
vi.mock('@plexo/queue', () => ({
    push: vi.fn(async () => 'fake-id'),
    list: vi.fn(async () => []),
}))
vi.mock('../../sse-emitter.js', () => ({
    emitToWorkspace: vi.fn(),
}))
vi.mock('../../agent-loop.js', () => ({
    cancelActiveTask: vi.fn(),
}))
vi.mock('../../event-tracker.js', () => ({
    trackEvent: vi.fn(),
}))

// ── Test harness boot ────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string
const TASK_ID = 'task-abc-123'

// Server started once per file in beforeAll (longer timeout than beforeEach).
// Using beforeEach with if(!server) was causing 10s test timeout under full-suite
// ordering because the 'listening' wait was charged against the first test.
beforeAll(async () => {
    const { tasksRouter } = await import('../tasks.js')
    const app = express()
    app.use(express.json())
    app.use('/api/v1/tasks', tasksRouter)
    const created = app.listen(0)
    server = created
    await new Promise<void>((resolve) => created.once('listening', () => resolve()))
    const addr = created.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
}, 30_000)

beforeEach(() => {
    ctl.stepRows = []
    ctl.taskWorkspaceId = 'ws-1'
    ctl.allowWorkspaceAccess = true
})

afterAll(() => { if (server) server.close() })

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/v1/tasks/:id/steps/raw', () => {
    it('happy path: valid task + member caller returns rows + total', async () => {
        ctl.stepRows = [
            { stepNumber: 1, toolCalls: [{ tool: 'read_file', input: { path: 'a' } }], stepState: { phase: 'start' }, createdAt: new Date('2026-04-11T00:00:00Z') },
            { stepNumber: 2, toolCalls: null, stepState: { phase: 'done' }, createdAt: new Date('2026-04-11T00:00:05Z') },
        ]

        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/steps/raw`)
        expect(res.status).toBe(200)

        const body = await res.json() as {
            taskId: string
            steps: Array<{ stepNumber: number; toolCalls: unknown; stepState: unknown; createdAt: string }>
            total: number
            truncated: boolean
        }
        expect(body.taskId).toBe(TASK_ID)
        expect(body.steps).toHaveLength(2)
        expect(body.steps[0]!.stepNumber).toBe(1)
        expect(body.steps[1]!.stepState).toEqual({ phase: 'done' })
        expect(body.total).toBe(2)
        expect(body.truncated).toBe(false)
    })

    it('404 when task is not found', async () => {
        ctl.taskWorkspaceId = null // fake DB returns no row for the task lookup

        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/steps/raw`)
        expect(res.status).toBe(404)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('NOT_FOUND')
    })

    it('403 when caller is not a workspace member', async () => {
        ctl.allowWorkspaceAccess = false

        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/steps/raw`)
        expect(res.status).toBe(403)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('FORBIDDEN')
    })

    it('truncation: returns first 200 rows and truncated:true when at the cap', async () => {
        // The route's own `.limit(200)` means the fake builder can only
        // ever surface up to 200 rows — so we simulate "hit the cap" by
        // returning exactly 200 rows. If the route ever relaxes its
        // limit, this test still asserts the truncation flag.
        ctl.stepRows = Array.from({ length: 200 }, (_, i) => ({
            stepNumber: i + 1,
            toolCalls: null,
            stepState: { i },
            createdAt: new Date('2026-04-11T00:00:00Z'),
        }))

        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}/steps/raw`)
        expect(res.status).toBe(200)
        const body = await res.json() as {
            steps: Array<{ stepNumber: number }>
            total: number
            truncated: boolean
        }
        expect(body.steps).toHaveLength(200)
        expect(body.total).toBe(200)
        expect(body.truncated).toBe(true)
        expect(body.steps[0]!.stepNumber).toBe(1)
        expect(body.steps[199]!.stepNumber).toBe(200)
    })
})
