// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for sprint conflict detection.
 *
 * detectStaticConflicts is pure and needs no mocking.
 * detectDynamicConflicts is tested with mocked DB + GitHub client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── DB + GitHub stubs ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => {
    const sprintTaskRows: Array<{ id: string; branch: string; status: string }> = []
    const sprintUpdateSpy = vi.fn()

    const dbSelect = vi.fn(() => ({
        from: () => ({
            where: () => Promise.resolve(sprintTaskRows),
        }),
    }))

    const dbUpdate = vi.fn(() => ({
        set: () => ({
            where: () => Promise.resolve(),
        }),
    }))

    const compareSpy = vi.fn()

    return { sprintTaskRows, sprintUpdateSpy, dbSelect, dbUpdate, compareSpy }
})

vi.mock('@plexo/db', () => ({
    db: {
        select: hoisted.dbSelect,
        update: hoisted.dbUpdate,
    },
    eq: (_col: unknown, _val: unknown) => true,
    sprintTasks: { sprintId: 'sprintId', id: 'id', branch: 'branch', status: 'status' },
    sprints: { id: 'id', conflictCount: 'conflictCount' },
}))

vi.mock('../github/client.js', () => ({
    buildGitHubClient: (_owner: string, _repo: string) => ({
        compare: hoisted.compareSpy,
    }),
}))

import { detectStaticConflicts, detectDynamicConflicts } from './conflicts.js'

describe('detectStaticConflicts', () => {
    it('returns empty array for empty task list', () => {
        expect(detectStaticConflicts([])).toEqual([])
    })

    it('returns empty array for a single task', () => {
        expect(detectStaticConflicts([{ id: 'a', scope: ['src/auth.ts'] }])).toEqual([])
    })

    it('returns empty when tasks have disjoint scopes', () => {
        const tasks = [
            { id: 'a', scope: ['src/auth.ts'] },
            { id: 'b', scope: ['src/billing.ts'] },
        ]
        expect(detectStaticConflicts(tasks)).toEqual([])
    })

    it('detects exact scope overlap between two tasks', () => {
        const tasks = [
            { id: 'a', scope: ['src/auth.ts'] },
            { id: 'b', scope: ['src/auth.ts'] },
        ]
        const result = detectStaticConflicts(tasks)
        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({ taskA: 'a', taskB: 'b', overlap: ['src/auth.ts'] })
    })

    it('detects prefix overlap (a is prefix of b)', () => {
        const tasks = [
            { id: 'a', scope: ['src/'] },
            { id: 'b', scope: ['src/auth.ts'] },
        ]
        const result = detectStaticConflicts(tasks)
        expect(result).toHaveLength(1)
        // overlap is filtered from a's scope — the entry that matched is 'src/'
        expect(result[0]!.overlap).toContain('src/')
    })

    it('detects reverse prefix overlap (b is prefix of a)', () => {
        const tasks = [
            { id: 'a', scope: ['src/auth.ts'] },
            { id: 'b', scope: ['src/'] },
        ]
        const result = detectStaticConflicts(tasks)
        expect(result).toHaveLength(1)
    })

    it('reports all conflicting pairs when three tasks overlap', () => {
        const tasks = [
            { id: 'a', scope: ['lib/core.ts'] },
            { id: 'b', scope: ['lib/core.ts'] },
            { id: 'c', scope: ['lib/core.ts'] },
        ]
        // a-b, a-c, b-c → 3 conflicts
        expect(detectStaticConflicts(tasks)).toHaveLength(3)
    })

    it('only includes the overlapping files in the overlap array', () => {
        const tasks = [
            { id: 'a', scope: ['src/auth.ts', 'src/db.ts'] },
            { id: 'b', scope: ['src/auth.ts', 'src/billing.ts'] },
        ]
        const result = detectStaticConflicts(tasks)
        expect(result).toHaveLength(1)
        expect(result[0]!.overlap).toEqual(['src/auth.ts'])
    })

    it('does not produce self-conflict entries', () => {
        const tasks = [{ id: 'a', scope: ['src/auth.ts'] }]
        const result = detectStaticConflicts(tasks)
        expect(result.every(c => c.taskA !== c.taskB)).toBe(true)
    })
})

describe('detectDynamicConflicts', () => {
    beforeEach(() => hoisted.compareSpy.mockClear())
    it('returns empty when no sprint tasks exist', async () => {
        hoisted.sprintTaskRows.length = 0
        hoisted.dbSelect.mockReturnValueOnce({
            from: () => ({ where: () => Promise.resolve([]) }),
        })

        const result = await detectDynamicConflicts('sprint-1', 'owner', 'repo', 'main')
        expect(result).toEqual([])
    })

    it('returns empty when completed tasks touch different files', async () => {
        const tasks = [
            { id: 't1', branch: 'feat/t1', status: 'complete' },
            { id: 't2', branch: 'feat/t2', status: 'complete' },
        ]
        hoisted.dbSelect.mockReturnValueOnce({
            from: () => ({ where: () => Promise.resolve(tasks) }),
        })
        hoisted.compareSpy
            .mockResolvedValueOnce({ files: [{ filename: 'src/a.ts' }] })
            .mockResolvedValueOnce({ files: [{ filename: 'src/b.ts' }] })

        const result = await detectDynamicConflicts('sprint-1', 'owner', 'repo', 'main')
        expect(result).toEqual([])
    })

    it('detects conflict when two branches both modified the same file', async () => {
        const tasks = [
            { id: 't1', branch: 'feat/t1', status: 'complete' },
            { id: 't2', branch: 'feat/t2', status: 'complete' },
        ]
        hoisted.dbSelect.mockReturnValueOnce({
            from: () => ({ where: () => Promise.resolve(tasks) }),
        })
        hoisted.compareSpy
            .mockResolvedValueOnce({ files: [{ filename: 'src/auth.ts' }, { filename: 'src/db.ts' }] })
            .mockResolvedValueOnce({ files: [{ filename: 'src/auth.ts' }, { filename: 'src/billing.ts' }] })

        const result = await detectDynamicConflicts('sprint-1', 'owner', 'repo', 'main')
        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({
            taskA: 't1',
            taskB: 't2',
            branchA: 'feat/t1',
            branchB: 'feat/t2',
            conflictingFiles: ['src/auth.ts'],
        })
    })

    it('skips tasks that are not complete or failed', async () => {
        const tasks = [
            { id: 't1', branch: 'feat/t1', status: 'running' },
            { id: 't2', branch: 'feat/t2', status: 'pending' },
        ]
        hoisted.dbSelect.mockReturnValueOnce({
            from: () => ({ where: () => Promise.resolve(tasks) }),
        })

        const result = await detectDynamicConflicts('sprint-1', 'owner', 'repo', 'main')
        expect(result).toEqual([])
        expect(hoisted.compareSpy).not.toHaveBeenCalled()
    })

    it('skips branch compare errors gracefully (no throw)', async () => {
        const tasks = [
            { id: 't1', branch: 'feat/t1', status: 'complete' },
            { id: 't2', branch: 'feat/t2', status: 'complete' },
        ]
        hoisted.dbSelect.mockReturnValueOnce({
            from: () => ({ where: () => Promise.resolve(tasks) }),
        })
        hoisted.compareSpy
            .mockRejectedValueOnce(new Error('GitHub 404'))
            .mockRejectedValueOnce(new Error('GitHub 404'))

        await expect(
            detectDynamicConflicts('sprint-1', 'owner', 'repo', 'main'),
        ).resolves.toEqual([])
    })
})
