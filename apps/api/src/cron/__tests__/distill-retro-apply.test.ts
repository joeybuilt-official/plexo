// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * applyRevision — fire-and-forget contract tests.
 *
 * Verifies that the Telegram approval path returns {ok:true} before the
 * Graphiti write completes (ADR-0010 Phase 1 perf gate).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const PROMPT_TEXT = 'Check the PR queue and summarize open items.'
const PROMPT_HASH = createHash('sha256').update(PROMPT_TEXT).digest('hex')

const MOCK_REVISION = {
    id: 'rv-ffffffff-0000-0000-0000-000000000001',
    routineId: 'rr-ffffffff-0000-0000-0000-000000000001',
    status: 'pending',
    basePromptHash: PROMPT_HASH,
    proposedDiff: 'Improved: Check the PR queue, prioritize blocked items first.',
    rationale: 'Three runs failed to surface blocked PRs.',
    sourceOutcomeIds: ['oc-001', 'oc-002'],
    version: 2,
}

const MOCK_ROUTINE = {
    prompt: PROMPT_TEXT,
    workspaceId: 'ws-ffffffff-0000-0000-0000-000000000001',
}

let _selectCallIdx = 0

vi.mock('@plexo/db', () => {
    const makeChain = (limitVal: unknown) => {
        const obj: Record<string, unknown> = {}
        for (const m of ['from', 'where', 'set', 'orderBy', 'returning', 'execute']) {
            obj[m] = vi.fn(() => obj)
        }
        obj.limit = vi.fn(async () => limitVal)
        return obj
    }

    return {
        db: {
            select: vi.fn(() => {
                const idx = _selectCallIdx++
                return makeChain(idx === 0 ? [MOCK_REVISION] : [MOCK_ROUTINE])
            }),
            update: vi.fn(() => {
                const obj: Record<string, unknown> = {}
                for (const m of ['set', 'where']) obj[m] = vi.fn(() => obj)
                return obj
            }),
        },
        eq: vi.fn(),
        and: vi.fn(),
        promptRevisions: {
            id: 'id', routineId: 'routineId', status: 'status',
            basePromptHash: 'basePromptHash', proposedDiff: 'proposedDiff',
            rationale: 'rationale', sourceOutcomeIds: 'sourceOutcomeIds', version: 'version',
        },
        cronJobs: { id: 'id', workspaceId: 'workspaceId', prompt: 'prompt' },
    }
})

const mockSend = vi.fn()

vi.mock('@plexo/queue/inngest', () => ({
    inngest: { send: mockSend },
}))

describe('applyRevision fire-and-forget', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        _selectCallIdx = 0
    })

    it('resolves {ok:true} before inngest.send() completes', async () => {
        // inngest.send returns a NEVER-resolving promise.
        // If applyRevision awaited it, this test would hang forever.
        let sendCalled = false
        mockSend.mockImplementation(() => {
            sendCalled = true
            return new Promise<void>(() => { /* intentionally never resolves */ })
        })

        const { applyRevision } = await import('../distill-retro.js')
        const result = await applyRevision(MOCK_REVISION.id, 'telegram:12345')

        expect(result).toEqual({ ok: true })
        expect(sendCalled).toBe(true)
    })

    it('calls inngest.send with lessons.graphiti.write event and correct payload', async () => {
        mockSend.mockResolvedValue(undefined)

        const { applyRevision } = await import('../distill-retro.js')
        await applyRevision(MOCK_REVISION.id, 'telegram:12345')

        expect(mockSend).toHaveBeenCalledOnce()
        const event = mockSend.mock.calls[0]![0]
        expect(event.name).toBe('lessons.graphiti.write')
        expect(event.data.workspaceId).toBe(MOCK_ROUTINE.workspaceId)
        expect(event.data.routineId).toBe(MOCK_REVISION.routineId)
        expect(event.data.revisionId).toBe(MOCK_REVISION.id)
        expect(event.data.version).toBe(2)
        expect(event.data.content).toBe(MOCK_REVISION.proposedDiff)
        expect(event.data.reviewedBy).toBe('telegram:12345')
        expect(event.data.sourceOutcomeIds).toEqual(['oc-001', 'oc-002'])
    })
})
