// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockInvalidateGraphitiLesson = vi.fn()

vi.mock('../../write-backend.js', () => ({
    invalidateGraphitiLesson: mockInvalidateGraphitiLesson,
}))

vi.mock('@plexo/queue/inngest', () => ({
    inngest: {
        createFunction: vi.fn().mockReturnValue({ id: () => 'lessons-graphiti-invalidate' }),
    },
}))

const mockDbUpdate = vi.fn()
const mockDbSet = vi.fn()
const mockDbWhere = vi.fn().mockResolvedValue(undefined)
const mockEq = vi.fn((col, val) => ({ col, val }))

vi.mock('@plexo/db', () => ({
    db: {
        update: vi.fn(() => {
            mockDbUpdate()
            return { set: (vals: unknown) => { mockDbSet(vals); return { where: mockDbWhere } } }
        }),
    },
    eq: mockEq,
    promptRevisions: { id: 'id' },
}))

const { handleLessonsInvalidate, lessonsInvalidateFn } = await import('../lessons-invalidate-fn.js')

const happyData = {
    workspaceId: 'ws-bbb',
    revisionId:  'rv-333',
    reviewedBy:  'telegram:1234567',
}

describe('handleLessonsInvalidate', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        delete process.env.GRAPHITI_LESSONS_ENABLED
    })

    afterEach(() => {
        delete process.env.GRAPHITI_LESSONS_ENABLED
    })

    it('returns skipped when GRAPHITI_LESSONS_ENABLED not set (default OFF)', async () => {
        const result = await handleLessonsInvalidate(happyData)
        expect(result).toEqual({ ok: true, skipped: true })
        expect(mockInvalidateGraphitiLesson).not.toHaveBeenCalled()
        expect(mockDbUpdate).not.toHaveBeenCalled()
    })

    it('returns skipped when GRAPHITI_LESSONS_ENABLED=0', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '0'
        const result = await handleLessonsInvalidate(happyData)
        expect(result).toEqual({ ok: true, skipped: true })
        expect(mockInvalidateGraphitiLesson).not.toHaveBeenCalled()
    })

    it('calls invalidateGraphitiLesson with workspaceId + revisionId when enabled', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockInvalidateGraphitiLesson.mockResolvedValueOnce({ ok: true, deleted: 3 })

        await handleLessonsInvalidate(happyData)

        expect(mockInvalidateGraphitiLesson).toHaveBeenCalledOnce()
        expect(mockInvalidateGraphitiLesson).toHaveBeenCalledWith('ws-bbb', 'rv-333')
    })

    it('propagates the invalidation result', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockInvalidateGraphitiLesson.mockResolvedValueOnce({ ok: true, deleted: 5 })

        const result = await handleLessonsInvalidate(happyData)
        expect(result).toEqual({ ok: true, deleted: 5 })
    })

    it('propagates skipped result when episode not found', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockInvalidateGraphitiLesson.mockResolvedValueOnce({ ok: true, deleted: 0, skipped: true })

        const result = await handleLessonsInvalidate(happyData)
        expect(result).toEqual({ ok: true, deleted: 0, skipped: true })
    })

    // ── Phase A — graphiti_invalidated_at write-back ──────────────────────────
    it('stamps graphiti_invalidated_at when delete succeeds (deleted>0)', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockInvalidateGraphitiLesson.mockResolvedValueOnce({ ok: true, deleted: 2 })

        await handleLessonsInvalidate(happyData)

        expect(mockDbUpdate).toHaveBeenCalledOnce()
        const setCall = mockDbSet.mock.calls[0]![0] as { graphitiInvalidatedAt: Date }
        expect(setCall.graphitiInvalidatedAt).toBeInstanceOf(Date)
    })

    it('stamps graphiti_invalidated_at even when deleted=0 (episode existed but had no edges)', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockInvalidateGraphitiLesson.mockResolvedValueOnce({ ok: true, deleted: 0 })

        await handleLessonsInvalidate(happyData)

        // Not skipped → cypher ran → stamp it (semantic: invalidation attempt happened)
        expect(mockDbUpdate).toHaveBeenCalledOnce()
    })

    it('does NOT stamp graphiti_invalidated_at when skipped (episode never written)', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockInvalidateGraphitiLesson.mockResolvedValueOnce({ ok: true, deleted: 0, skipped: true })

        await handleLessonsInvalidate(happyData)
        expect(mockDbUpdate).not.toHaveBeenCalled()
    })

    it('DB stamp failure does not fail the invalidation (delete succeeded)', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockInvalidateGraphitiLesson.mockResolvedValueOnce({ ok: true, deleted: 1 })
        mockDbWhere.mockRejectedValueOnce(new Error('db down'))

        const result = await handleLessonsInvalidate(happyData)
        expect(result).toEqual({ ok: true, deleted: 1 })
    })
})

describe('lessonsInvalidateFn config', () => {
    it('is registered as an Inngest function', () => {
        expect(lessonsInvalidateFn).toBeDefined()
        expect(typeof lessonsInvalidateFn.id).toBe('function')
        expect(lessonsInvalidateFn.id()).toContain('lessons-graphiti-invalidate')
    })
})
