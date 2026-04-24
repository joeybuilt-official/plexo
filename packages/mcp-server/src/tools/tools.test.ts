// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpContext } from '../types.js'

// ── DB mock ───────────────────────────────────────────────────────────────────
vi.mock('@plexo/db', () => ({
    db: {
        execute: vi.fn(),
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
    },
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    eq: vi.fn(),
    and: vi.fn(),
}))

// ── Auth mock ─────────────────────────────────────────────────────────────────
vi.mock('../auth.js', () => ({
    requireScope: vi.fn().mockReturnValue(true),
}))
vi.mock('../errors.js', () => ({
    scopeDenied: vi.fn((scope: string) => ({ error: 'SCOPE_DENIED', scope })),
    internalError: vi.fn((id: string) => ({ error: 'INTERNAL_ERROR', correlation_id: id })),
}))
vi.mock('../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// ── Queue mock ────────────────────────────────────────────────────────────────
vi.mock('@plexo/queue', () => ({
    addTask: vi.fn().mockResolvedValue({ id: 'task-id-123' }),
}))

// ── Tests ─────────────────────────────────────────────────────────────────────

const mockCtx: McpContext = {
    workspace_id: 'ws-0001',
    token_id: 'tok-0001',
    scopes: ['tasks:read', 'tasks:write', 'memory:read', 'memory:write', 'system:read'],
}

describe('plexo_list_tasks', () => {
    it('returns task rows from db.execute', async () => {
        const { db } = await import('@plexo/db')
        const mockRows = [
            { id: 't1', type: 'general', status: 'completed', request: 'write a poem', created_at: '2026-01-01' },
        ]
        vi.mocked(db.execute).mockResolvedValueOnce(mockRows as any)

        const { plexoListTasks } = await import('./tasks.js')
        const result = await plexoListTasks({ limit: 5 }, mockCtx) as any
        expect(result.tasks).toHaveLength(1)
        expect(result.tasks[0].id).toBe('t1')
    })

    it('filters by status when provided', async () => {
        const { db } = await import('@plexo/db')
        vi.mocked(db.execute).mockResolvedValueOnce(Object.assign([], { columns: [], count: 0, command: '', statement: '', state: '' }) as any)

        const { plexoListTasks } = await import('./tasks.js')
        const result = await plexoListTasks({ status: 'running', limit: 5 }, mockCtx) as any
        expect(result.tasks).toHaveLength(0)
        expect(db.execute).toHaveBeenCalled()
    })
})

describe('plexo_create_task', () => {
    it('enqueues a task and returns its id', async () => {
        const { db } = await import('@plexo/db')
        vi.mocked(db.execute).mockResolvedValueOnce(Object.assign([], { columns: [], count: 0, command: '', statement: '', state: '' }) as any)

        const { plexoCreateTask } = await import('./tasks.js')
        const result = await plexoCreateTask({ request: 'do something', type: 'general' }, mockCtx) as any
        // Returns { id, type, status, request, created_at, message }
        expect(result.id).toBeDefined()
        expect(result.status).toBe('queued')
    })
})

describe('plexo_get_task', () => {
    it('returns error code NOT_FOUND when task not found', async () => {
        const { db } = await import('@plexo/db')
        vi.mocked(db.execute).mockResolvedValueOnce(Object.assign([], { columns: [], count: 0, command: '', statement: '', state: '' }) as any)

        const { plexoGetTask } = await import('./tasks.js')
        const result = await plexoGetTask(
            { task_id: '00000000-0000-0000-0000-000000000001' },
            mockCtx,
        ) as any
        expect(result.code).toBe('NOT_FOUND')
    })
})

describe('plexo_cancel_task', () => {
    it('returns error code NOT_CANCELABLE when task does not exist or is terminal', async () => {
        const { db } = await import('@plexo/db')
        vi.mocked(db.execute).mockResolvedValueOnce(Object.assign([], { columns: [], count: 0, command: '', statement: '', state: '' }) as any)

        const { plexoCancelTask } = await import('./tasks.js')
        const result = await plexoCancelTask(
            { task_id: '00000000-0000-0000-0000-000000000002' },
            mockCtx,
        ) as any
        expect(result.code).toBe('NOT_CANCELABLE')
    })
})

describe('plexo_search_memory', () => {
    it('returns matching entries', async () => {
        const { db } = await import('@plexo/db')
        const memRows = [
            { id: 'm1', content: 'always use TypeScript strict mode', type: 'pattern', created_at: '2026-01-01' },
        ]
        vi.mocked(db.execute).mockResolvedValueOnce(memRows as any)

        const { plexoSearchMemory } = await import('./memory.js')
        const result = await plexoSearchMemory({ query: 'TypeScript', limit: 5 }, mockCtx) as any
        expect(result.results).toHaveLength(1)
        expect(result.results[0].content).toContain('TypeScript')
    })
})

describe('plexo_remember', () => {
    it('inserts a memory entry and returns ok', async () => {
        const { db } = await import('@plexo/db')
        vi.mocked(db.execute).mockResolvedValueOnce(Object.assign([], { columns: [], count: 0, command: '', statement: '', state: '' }) as any)

        const { plexoRemember } = await import('./memory.js')
        const result = await plexoRemember({ content: 'always test first', type: 'pattern' }, mockCtx) as any
        expect(result.ok).toBe(true)
        expect(result.id).toBeDefined()
    })
})
