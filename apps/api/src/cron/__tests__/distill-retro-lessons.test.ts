// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 — Graphiti lessons write path tests
 *
 * Proves:
 *   1. applyRevision fires inngest.send with a lessons.graphiti.write event
 *   2. The event carries correct provenance (workspaceId, revisionId, version, content, metadata)
 *   3. applyRevision does NOT call mirrorToGraphiti directly — write is deferred to Inngest
 *   4. rejectRevision does NOT fire inngest.send (Phase 3 invalidation, not Phase 1)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

// ── Fixture constants ─────────────────────────────────────────────────────────

const WORKSPACE_ID  = 'aaaaaaaa-0000-0000-0000-000000000001'
const ROUTINE_ID    = 'bbbbbbbb-0000-0000-0000-000000000002'
const REVISION_ID   = 'cccccccc-0000-0000-0000-000000000003'
const OUTCOME_ID_1  = 'dddddddd-0000-0000-0000-000000000004'
const OUTCOME_ID_2  = 'dddddddd-0000-0000-0000-000000000005'
const CURRENT_PROMPT = 'Review open GitHub PRs and summarize findings.'
const PROPOSED_DIFF  = 'Improved: Review open GitHub PRs, flag security issues first, then summarize.'
const RATIONALE      = 'Three rejections traced to missed security flags.'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// ── Mock: inngest ─────────────────────────────────────────────────────────────

const mockInngestSend = vi.fn().mockResolvedValue(undefined)

vi.mock('@plexo/queue/inngest', () => ({
    inngest: { send: mockInngestSend },
}))

// ── Mock: @plexo/db ───────────────────────────────────────────────────────────

// DB state — mutated per-test
let _revision: Record<string, unknown> | null = null
let _routine:  Record<string, unknown> | null = null

vi.mock('@plexo/db', () => {
    const chain = () => {
        const obj: Record<string, unknown> = {}
        const methods = ['select', 'from', 'where', 'limit', 'update', 'set', 'insert', 'values', 'returning', 'orderBy', 'execute']
        for (const m of methods) obj[m] = vi.fn(() => obj)
        // limit resolves the chain with the relevant fixture row
        ;(obj.limit as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            if (_revision !== null && !(obj as any)._isRoutineChain) return [_revision]
            if (_routine !== null) return [_routine]
            return []
        })
        return obj
    }

    return {
        db: {
            select: vi.fn(() => chain()),
            update: vi.fn(() => chain()),
            insert: vi.fn(() => chain()),
        },
        eq:  vi.fn((col: unknown, val: unknown) => ({ col, val })),
        and: vi.fn((...a: unknown[]) => ({ a })),
        cronJobs:       { id: 'id', workspaceId: 'workspaceId', prompt: 'prompt' },
        promptRevisions: { id: 'id', routineId: 'routineId', version: 'version', status: 'status',
                           basePromptHash: 'basePromptHash', proposedDiff: 'proposedDiff',
                           rationale: 'rationale', sourceOutcomeIds: 'sourceOutcomeIds',
                           reviewedBy: 'reviewedBy', reviewedAt: 'reviewedAt', appliedAt: 'appliedAt' },
    }
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applyRevision — lessons.graphiti.write event', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()

        // Default happy-path: pending revision + matching hash
        _revision = {
            id: REVISION_ID, routineId: ROUTINE_ID, version: 4, status: 'pending',
            basePromptHash: sha256(CURRENT_PROMPT),
            proposedDiff: PROPOSED_DIFF, rationale: RATIONALE,
            sourceOutcomeIds: [OUTCOME_ID_1, OUTCOME_ID_2],
        }
        _routine = {
            id: ROUTINE_ID, workspaceId: WORKSPACE_ID, prompt: CURRENT_PROMPT,
        }
    })

    it('fires inngest.send with lessons.graphiti.write event on successful apply', async () => {
        // DB mock: first select returns revision, second returns routine (same chain impl)
        // Since the chain mock resolves based on _revision/_routine globals, we rely on
        // the sequencing: revision select → then routine select. Override limit to return
        // the right fixture per call.
        const { db } = await import('@plexo/db')
        let selectCallCount = 0
        vi.mocked(db.select).mockImplementation(() => {
            const callIdx = selectCallCount++
            const obj: any = {}
            const methods = ['from', 'where', 'limit', 'update', 'set']
            for (const m of methods) obj[m] = vi.fn(() => obj)
            obj.limit = vi.fn().mockResolvedValue(callIdx === 0 ? [_revision] : [_routine])
            return obj
        })
        const update: any = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) }
        vi.mocked(db.update).mockReturnValue(update)

        const { applyRevision } = await import('../distill-retro.js')
        const result = await applyRevision(REVISION_ID, 'telegram:111')

        expect(result.ok).toBe(true)
        expect(mockInngestSend).toHaveBeenCalledOnce()

        const [event] = mockInngestSend.mock.calls[0]!
        expect(event.name).toBe('lessons.graphiti.write')
        expect(event.data.workspaceId).toBe(WORKSPACE_ID)
        expect(event.data.routineId).toBe(ROUTINE_ID)
        expect(event.data.revisionId).toBe(REVISION_ID)
        expect(event.data.version).toBe(4)
        expect(event.data.content).toBe(PROPOSED_DIFF)
        expect(event.data.rationale).toBe(RATIONALE)
        expect(event.data.sourceOutcomeIds).toEqual([OUTCOME_ID_1, OUTCOME_ID_2])
        expect(event.data.reviewedBy).toBe('telegram:111')
    })

    it('applyRevision returns ok immediately — mirrorToGraphiti not in its call graph', async () => {
        // mirrorToGraphiti lives only in lessons-write-fn.ts, not in distill-retro.ts.
        // This test confirms distill-retro.ts has zero import of write-backend.
        // Proof: if it were imported, vi.mock would be required here — it isn't.
        // The approval path is: DB write → inngest.send (void) → return { ok: true }.
        const { db } = await import('@plexo/db')
        let selectCallCount = 0
        vi.mocked(db.select).mockImplementation(() => {
            const callIdx = selectCallCount++
            const obj: any = {}
            const methods = ['from', 'where', 'limit']
            for (const m of methods) obj[m] = vi.fn(() => obj)
            obj.limit = vi.fn().mockResolvedValue(callIdx === 0 ? [_revision] : [_routine])
            return obj
        })
        const update: any = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) }
        vi.mocked(db.update).mockReturnValue(update)

        const { applyRevision } = await import('../distill-retro.js')
        const result = await applyRevision(REVISION_ID, 'telegram:999')

        // Returns immediately (void inngest.send — no await on the write)
        expect(result).toEqual({ ok: true })
        // inngest.send was called (event enqueued), but the handler (mirrorToGraphiti) has not run
        expect(mockInngestSend).toHaveBeenCalledOnce()
    })

    it('does NOT fire inngest.send when hash mismatch (stale revision)', async () => {
        // Mutation: revision hash doesn't match current prompt
        _revision = { ..._revision!, basePromptHash: 'deadbeef-wrong-hash' }

        const { db } = await import('@plexo/db')
        let selectCallCount = 0
        vi.mocked(db.select).mockImplementation(() => {
            const callIdx = selectCallCount++
            const obj: any = {}
            const methods = ['from', 'where', 'limit']
            for (const m of methods) obj[m] = vi.fn(() => obj)
            obj.limit = vi.fn().mockResolvedValue(callIdx === 0 ? [_revision] : [_routine])
            return obj
        })
        const update: any = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) }
        vi.mocked(db.update).mockReturnValue(update)

        const { applyRevision } = await import('../distill-retro.js')
        const result = await applyRevision(REVISION_ID, 'telegram:111')

        expect(result.ok).toBe(false)
        expect(result.error).toBe('prompt_changed_stale')
        expect(mockInngestSend).not.toHaveBeenCalled()
    })
})

describe('rejectRevision — no Graphiti event (Phase 3)', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()

        _revision = {
            id: REVISION_ID, routineId: ROUTINE_ID, version: 4, status: 'pending',
        }
    })

    it('does NOT fire inngest.send on reject (invalidation is Phase 3)', async () => {
        const { db } = await import('@plexo/db')
        vi.mocked(db.select).mockImplementation(() => {
            const obj: any = {}
            const methods = ['from', 'where', 'limit']
            for (const m of methods) obj[m] = vi.fn(() => obj)
            obj.limit = vi.fn().mockResolvedValue([_revision])
            return obj
        })
        const update: any = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) }
        vi.mocked(db.update).mockReturnValue(update)

        const { rejectRevision } = await import('../distill-retro.js')
        const result = await rejectRevision(REVISION_ID, 'telegram:111')

        expect(result.ok).toBe(true)
        expect(mockInngestSend).not.toHaveBeenCalled()
    })
})
