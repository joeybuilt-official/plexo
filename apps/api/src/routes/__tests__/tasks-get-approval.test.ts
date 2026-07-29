// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase K Item 21 — GET /api/tasks/:id approval enrichment is parallelized
 * with the steps + events queries via a single Promise.all.
 *
 * Pins:
 *   1. awaiting_approval + valid _approvalId → response.approval == decision record
 *   2. awaiting_approval + getDecision throws → approval == null (graceful)
 *   3. status !== 'awaiting_approval' → approval == null and getDecision is NOT called
 *      (ensures we don't burn a Redis RTT for non-awaiting tasks)
 *   4. awaiting_approval but no _approvalId in context → approval == null
 *
 * Mirrors the mock-the-router pattern from tasks-raw-steps.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    task: null as null | {
        id: string
        workspaceId: string
        status: string
        context: Record<string, unknown> | null
    },
    decisionRecord: null as null | { id: string; decision: 'approved' | 'rejected' | 'pending'; taskId: string },
    decisionThrows: false,
    decisionCallCount: 0,
    allowWorkspaceAccess: true,
}

vi.mock('@plexo/db', () => {
    const tasksSentinel = { __table: 'tasks', id: 'id', workspaceId: 'workspace_id' }
    const taskStepsSentinel = { __table: 'task_steps', taskId: 'task_id', stepNumber: 'step_number' }
    const eventsSentinel = {
        __table: 'plexo_ops_task_events',
        id: 'id', eventType: 'event_type', fromState: 'from_state', toState: 'to_state',
        metadata: 'metadata', recordedAt: 'recorded_at', taskId: 'task_id', workspaceId: 'workspace_id',
    }
    const artifactsSentinel = { __table: 'artifacts', id: 'id', taskId: 'task_id', meta: 'meta', updatedAt: 'updated_at', filename: 'filename', type: 'type', kind: 'kind', currentVersion: 'current_version' }
    const artifactVersionsSentinel = { __table: 'artifact_versions', artifactId: 'artifact_id', version: 'version', content: 'content', changeDescription: 'change_description', createdAt: 'created_at' }

    function makeBuilder(_initialFields?: unknown): any {
        const state: { table: unknown } = { table: undefined }
        return {
            from(t: unknown) { state.table = t; return this },
            where() { return this },
            orderBy() { return this },
            innerJoin() { return this },
            async limit(_n: number) {
                if (state.table === tasksSentinel) {
                    return ctl.task ? [ctl.task] : []
                }
                if (state.table === taskStepsSentinel) {
                    return []
                }
                if (state.table === eventsSentinel) {
                    return []
                }
                return []
            },
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
            select: (_fields?: unknown) => makeBuilder(_fields),
            execute: vi.fn(async () => []),
            update: (_t: unknown) => makeBuilder(undefined),
            insert: (_t: unknown) => makeBuilder(undefined),
        },
        tasks: tasksSentinel,
        taskSteps: taskStepsSentinel,
        plexoOpsTaskEvents: eventsSentinel,
        artifacts: artifactsSentinel,
        artifactVersions: artifactVersionsSentinel,
        inferKind: vi.fn(() => ({ kind: 'doc', language: null })),
        eq: vi.fn(),
        and: vi.fn(),
        asc: vi.fn(),
        desc: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('@plexo/agent/one-way-door', () => ({
    getDecision: vi.fn(async (_id: string) => {
        ctl.decisionCallCount += 1
        if (ctl.decisionThrows) throw new Error('redis down')
        return ctl.decisionRecord
    }),
    resolveDecision: vi.fn(),
    requestApproval: vi.fn(),
    waitForDecision: vi.fn(),
}))

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

vi.mock('@plexo/queue', () => ({
    push: vi.fn(async () => 'fake-id'),
    list: vi.fn(async () => []),
    cancel: vi.fn(async () => undefined),
}))
vi.mock('@plexo/agent/executor/step-builder', () => ({
    getResumeStep: vi.fn(async () => 0),
}))
vi.mock('../../sse-emitter.js', () => ({ emitToWorkspace: vi.fn() }))
vi.mock('../../agent-loop.js', () => ({ cancelActiveTask: vi.fn() }))
vi.mock('../../event-tracker.js', () => ({ trackEvent: vi.fn() }))
vi.mock('../../audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../conversation-log.js', () => ({ recordConversation: vi.fn(async () => undefined) }))

let server: Server | null = null
let baseUrl: string
const TASK_ID = 'task-pk21-abc'
const APPROVAL_ID = 'owd-approval-xyz'

beforeEach(async () => {
    ctl.task = null
    ctl.decisionRecord = null
    ctl.decisionThrows = false
    ctl.decisionCallCount = 0
    ctl.allowWorkspaceAccess = true
    if (!server) {
        const { tasksRouter } = await import('../tasks.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/tasks', tasksRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

describe('GET /api/v1/tasks/:id — approval enrichment Promise.all (Phase K Item 21)', () => {
    it('awaiting_approval + valid _approvalId → response includes the decision record', async () => {
        ctl.task = {
            id: TASK_ID,
            workspaceId: 'ws-1',
            status: 'awaiting_approval',
            context: { _approvalId: APPROVAL_ID },
        }
        ctl.decisionRecord = { id: APPROVAL_ID, decision: 'pending', taskId: TASK_ID }

        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}`)
        expect(res.status).toBe(200)
        const body = await res.json() as { task: unknown; steps: unknown[]; events: unknown[]; approval: { id: string; decision: string } | null }
        expect(body.approval).not.toBeNull()
        expect(body.approval!.id).toBe(APPROVAL_ID)
        expect(body.approval!.decision).toBe('pending')
        expect(ctl.decisionCallCount).toBe(1)
    })

    it('awaiting_approval + getDecision throws → approval=null, no 500', async () => {
        ctl.task = {
            id: TASK_ID,
            workspaceId: 'ws-1',
            status: 'awaiting_approval',
            context: { _approvalId: APPROVAL_ID },
        }
        ctl.decisionThrows = true

        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}`)
        expect(res.status).toBe(200)
        const body = await res.json() as { approval: unknown }
        expect(body.approval).toBeNull()
        expect(ctl.decisionCallCount).toBe(1)
    })

    it('non-awaiting task → approval=null and getDecision is NOT called', async () => {
        ctl.task = {
            id: TASK_ID,
            workspaceId: 'ws-1',
            status: 'running',
            context: { _approvalId: APPROVAL_ID }, // present but task isn't awaiting
        }

        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}`)
        expect(res.status).toBe(200)
        const body = await res.json() as { approval: unknown }
        expect(body.approval).toBeNull()
        // Item 21 invariant: non-awaiting tasks must skip the Redis RTT entirely.
        expect(ctl.decisionCallCount).toBe(0)
    })

    it('awaiting_approval but no _approvalId in context → approval=null, no Redis call', async () => {
        ctl.task = {
            id: TASK_ID,
            workspaceId: 'ws-1',
            status: 'awaiting_approval',
            context: {},
        }

        const res = await fetch(`${baseUrl}/api/v1/tasks/${TASK_ID}`)
        expect(res.status).toBe(200)
        const body = await res.json() as { approval: unknown }
        expect(body.approval).toBeNull()
        expect(ctl.decisionCallCount).toBe(0)
    })
})
