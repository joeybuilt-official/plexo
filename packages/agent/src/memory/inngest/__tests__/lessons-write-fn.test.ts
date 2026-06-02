// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockMirrorToGraphiti = vi.fn()

vi.mock('../../write-backend.js', () => ({
    mirrorToGraphiti: mockMirrorToGraphiti,
}))

vi.mock('@plexo/queue/inngest', () => ({
    inngest: {
        createFunction: vi.fn().mockReturnValue({ id: () => 'lessons-graphiti-write' }),
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

const { handleLessonsWrite, lessonsWriteFn } = await import('../lessons-write-fn.js')

const happyData = {
    workspaceId: 'ws-aaa',
    routineId:   'rr-111',
    revisionId:  'rv-222',
    version:     3,
    content:     'Lesson: always validate inputs before dispatch.',
    rationale:   'Three human rejections traced to unvalidated payloads.',
    sourceOutcomeIds: ['oc-001', 'oc-002'],
    reviewedBy:  'telegram:7654321',
}

describe('handleLessonsWrite', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        delete process.env.GRAPHITI_LESSONS_ENABLED
    })

    afterEach(() => {
        delete process.env.GRAPHITI_LESSONS_ENABLED
    })

    it('returns skipped when GRAPHITI_LESSONS_ENABLED is not set (default OFF)', async () => {
        const result = await handleLessonsWrite(happyData)
        expect(result).toEqual({ ok: true, skipped: true })
        expect(mockMirrorToGraphiti).not.toHaveBeenCalled()
        expect(mockDbUpdate).not.toHaveBeenCalled()
    })

    it('returns skipped when GRAPHITI_LESSONS_ENABLED=0', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '0'
        const result = await handleLessonsWrite(happyData)
        expect(result).toEqual({ ok: true, skipped: true })
        expect(mockMirrorToGraphiti).not.toHaveBeenCalled()
    })

    it('calls mirrorToGraphiti with correct args when GRAPHITI_LESSONS_ENABLED=1', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockMirrorToGraphiti.mockResolvedValueOnce({ ok: true, episodeId: 'ep-xyz', extractedFactsCount: 1 })

        await handleLessonsWrite(happyData)

        expect(mockMirrorToGraphiti).toHaveBeenCalledOnce()
        const call = mockMirrorToGraphiti.mock.calls[0]![0]
        expect(call.workspaceId).toBe('ws-aaa')
        expect(call.content).toBe(happyData.content)
        expect(call.name).toBe('lesson:rv-222')
        expect(call.sourceDescription).toContain('lesson v3')
        expect(call.sourceDescription).toContain('rr-111')
    })

    it('metadata includes tag=lesson + all provenance fields', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockMirrorToGraphiti.mockResolvedValueOnce({ ok: true, episodeId: 'ep-xyz', extractedFactsCount: 1 })

        await handleLessonsWrite(happyData)

        const meta = mockMirrorToGraphiti.mock.calls[0]![0].metadata
        expect(meta.tag).toBe('lesson')
        expect(meta.routineId).toBe('rr-111')
        expect(meta.revisionId).toBe('rv-222')
        expect(meta.version).toBe(3)
        expect(meta.sourceOutcomeIds).toEqual(['oc-001', 'oc-002'])
        expect(meta.reviewedBy).toBe('telegram:7654321')
    })

    it('propagates mirror_failed reason when mirrorToGraphiti returns ok=false', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockMirrorToGraphiti.mockResolvedValueOnce({ ok: false, episodeId: null, extractedFactsCount: 0 })

        const result = await handleLessonsWrite(happyData)
        expect(result.ok).toBe(false)
        expect(result.reason).toBe('mirror_failed')
        expect(mockDbUpdate).not.toHaveBeenCalled()
    })

    // ── Phase B — facts=0 guard ───────────────────────────────────────────────
    it('facts=0 guard: returns ok=false with reason=no_facts_extracted', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockMirrorToGraphiti.mockResolvedValueOnce({ ok: true, episodeId: 'ep-empty', extractedFactsCount: 0 })

        const result = await handleLessonsWrite(happyData)
        expect(result.ok).toBe(false)
        expect(result.reason).toBe('no_facts_extracted')
        expect(result.episodeId).toBe('ep-empty')
        expect(result.extractedFactsCount).toBe(0)
    })

    it('facts=0 guard: does NOT write back graphiti_episode_id', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockMirrorToGraphiti.mockResolvedValueOnce({ ok: true, episodeId: 'ep-empty', extractedFactsCount: 0 })

        await handleLessonsWrite(happyData)
        expect(mockDbUpdate).not.toHaveBeenCalled()
        expect(mockDbSet).not.toHaveBeenCalled()
    })

    it('facts=0 guard: undefined extractedFactsCount treated as 0', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockMirrorToGraphiti.mockResolvedValueOnce({ ok: true, episodeId: 'ep-no-count' })

        const result = await handleLessonsWrite(happyData)
        expect(result.ok).toBe(false)
        expect(result.reason).toBe('no_facts_extracted')
        expect(mockDbUpdate).not.toHaveBeenCalled()
    })

    // ── Phase A — episode_id write-back ───────────────────────────────────────
    it('writes back graphiti_episode_id when write succeeds with facts>0', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockMirrorToGraphiti.mockResolvedValueOnce({ ok: true, episodeId: 'ep-real-uuid', extractedFactsCount: 2 })

        const result = await handleLessonsWrite(happyData)
        expect(result.ok).toBe(true)
        expect(result.episodeId).toBe('ep-real-uuid')
        expect(result.extractedFactsCount).toBe(2)
        expect(mockDbUpdate).toHaveBeenCalledOnce()
        expect(mockDbSet).toHaveBeenCalledWith({ graphitiEpisodeId: 'ep-real-uuid' })
    })

    it('write-back DB failure does not fail the overall write (graphiti succeeded)', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockMirrorToGraphiti.mockResolvedValueOnce({ ok: true, episodeId: 'ep-db-fail', extractedFactsCount: 1 })
        mockDbWhere.mockRejectedValueOnce(new Error('db down'))

        const result = await handleLessonsWrite(happyData)
        expect(result.ok).toBe(true) // graphiti write was real; DB stamp is best-effort
        expect(result.episodeId).toBe('ep-db-fail')
    })

    it('null episodeId: skips write-back without erroring', async () => {
        process.env.GRAPHITI_LESSONS_ENABLED = '1'
        mockMirrorToGraphiti.mockResolvedValueOnce({ ok: true, episodeId: null, extractedFactsCount: 1 })

        const result = await handleLessonsWrite(happyData)
        expect(result.ok).toBe(true)
        expect(mockDbUpdate).not.toHaveBeenCalled()
    })
})

describe('lessonsWriteFn config', () => {
    it('is registered as an Inngest function', () => {
        expect(lessonsWriteFn).toBeDefined()
        expect(typeof lessonsWriteFn.id).toBe('function')
        expect(lessonsWriteFn.id()).toContain('lessons-graphiti-write')
    })
})
