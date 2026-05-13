// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tests for the Phase 5 promotion router.
 *
 * decideRoute() is a pure function over a row shape, so most coverage is
 * in-memory. promoteSuggestion() is exercised against a mocked DB +
 * eventBus to confirm the event topic + idempotency behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@plexo/db', () => ({
    db: { execute: vi.fn(async () => [] as unknown[]) },
    sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, values: vals, _kind: 'sql' }),
}))

vi.mock('../../plugins/event-bus.js', () => ({
    eventBus: { publish: vi.fn() },
}))

import { decideRoute, promoteSuggestion, autoPromoteAboveThreshold } from '../promote.js'
import { db } from '@plexo/db'
import { eventBus } from '../../plugins/event-bus.js'

const dbExecute = vi.mocked(db.execute)
const publishMock = vi.mocked(eventBus.publish)

beforeEach(() => {
    dbExecute.mockReset()
    publishMock.mockReset()
})

describe('decideRoute (pure)', () => {
    it('returns null when no rule matches', () => {
        const d = decideRoute({
            id: 's1', workspaceId: 'w1', kind: 'random', payload: {}, score: 1, status: 'pending',
        })
        expect(d).toBeNull()
    })

    it('routes a note with imperative language to levio.tasks.create', () => {
        const d = decideRoute({
            id: 's1', workspaceId: 'w1', kind: 'note',
            payload: { text: 'I should ship the launch checklist tomorrow.' },
            score: 1.2, status: 'pending',
        })
        expect(d).not.toBeNull()
        expect(d!.target).toBe('levio.tasks.create')
        expect((d!.payload.title as string).length).toBeGreaterThan(0)
    })

    it('routes a non-imperative note to no target', () => {
        const d = decideRoute({
            id: 's1', workspaceId: 'w1', kind: 'note',
            payload: { text: 'Notes from the meeting about Q3 results.' },
            score: 0.9, status: 'pending',
        })
        expect(d).toBeNull()
    })

    it('routes asset_cluster ≥ 3 members to fonto.projects.create', () => {
        const d = decideRoute({
            id: 's1', workspaceId: 'w1', kind: 'asset_cluster',
            payload: { label: 'Brand kit photos', memberIds: ['a', 'b', 'c', 'd'] },
            score: 1.4, status: 'pending',
        })
        expect(d).not.toBeNull()
        expect(d!.target).toBe('fonto.projects.create')
        expect((d!.payload.assetIds as unknown[]).length).toBe(4)
    })

    it('skips asset_cluster < 3 members', () => {
        const d = decideRoute({
            id: 's1', workspaceId: 'w1', kind: 'asset_cluster',
            payload: { memberIds: ['a', 'b'] },
            score: 1.4, status: 'pending',
        })
        expect(d).toBeNull()
    })

    it('routes spend_pattern with merchant + band + occurrences to fylo.budget.signal', () => {
        const d = decideRoute({
            id: 's1', workspaceId: 'w1', kind: 'spend_pattern',
            payload: { merchant: 'Stripe', amountBand: '$50-$100', occurrences: 4 },
            score: 1.7, status: 'pending',
        })
        expect(d).not.toBeNull()
        expect(d!.target).toBe('fylo.budget.signal')
    })

    it('skips spend_pattern below occurrence floor', () => {
        const d = decideRoute({
            id: 's1', workspaceId: 'w1', kind: 'spend_pattern',
            payload: { merchant: 'Stripe', amountBand: '$50', occurrences: 1 },
            score: 1.7, status: 'pending',
        })
        expect(d).toBeNull()
    })
})

describe('promoteSuggestion', () => {
    it('throws SUGGESTION_NOT_FOUND when the row is missing', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
;(dbExecute as any).mockResolvedValueOnce([])
        await expect(promoteSuggestion('w1', '00000000-0000-0000-0000-0000000000aa'))
            .rejects.toMatchObject({ code: 'SUGGESTION_NOT_FOUND' })
    })

    it('publishes the matching event topic + marks the row promoted', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(dbExecute as any)
            .mockResolvedValueOnce([{
                id: 's1', workspace_id: 'w1', kind: 'note',
                payload: { text: 'I need to send the contract today.' },
                score: 1.4, status: 'pending',
            }])
            .mockResolvedValueOnce([])

        const decision = await promoteSuggestion('w1', 's1')
        expect(decision.target).toBe('levio.tasks.create')
        expect(publishMock).toHaveBeenCalledTimes(1)
        expect(publishMock.mock.calls[0]?.[0]).toBe('ext.synthesis-promote.levio.tasks.create')
        // Two execute() calls: SELECT + UPDATE
        expect(dbExecute).toHaveBeenCalledTimes(2)
    })

    it('is idempotent — a second call on a promoted row does not re-emit', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
;(dbExecute as any).mockResolvedValueOnce([{
            id: 's1', workspace_id: 'w1', kind: 'note',
            payload: { text: 'I need to send the contract today.' },
            score: 1.4, status: 'promoted',
        }])

        const decision = await promoteSuggestion('w1', 's1')
        expect(decision.alreadyPromoted).toBe(true)
        expect(publishMock).not.toHaveBeenCalled()
    })

    it('honours dryRun by skipping event + DB update', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
;(dbExecute as any).mockResolvedValueOnce([{
            id: 's1', workspace_id: 'w1', kind: 'asset_cluster',
            payload: { label: 'Wedding photos', memberIds: ['1', '2', '3'] },
            score: 1.6, status: 'pending',
        }])
        const decision = await promoteSuggestion('w1', 's1', { dryRun: true })
        expect(decision.target).toBe('fonto.projects.create')
        expect(publishMock).not.toHaveBeenCalled()
        expect(dbExecute).toHaveBeenCalledTimes(1)
    })
})

describe('autoPromoteAboveThreshold', () => {
    it('returns zero counts on empty input (edge case)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
;(dbExecute as any).mockResolvedValueOnce([])
        const r = await autoPromoteAboveThreshold({ workspaceId: 'w1' })
        expect(r.inspected).toBe(0)
        expect(r.promoted).toBe(0)
    })

    it('promotes each pending suggestion above threshold', async () => {
        // First call: SELECT pending list (returns 2 ids)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
;(dbExecute as any).mockResolvedValueOnce([{ id: 's1' }, { id: 's2' }])
        // Then promoteSuggestion's SELECT + UPDATE for s1
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
;(dbExecute as any).mockResolvedValueOnce([{
            id: 's1', workspace_id: 'w1', kind: 'note',
            payload: { text: 'I need to ship it' }, score: 2, status: 'pending',
        }])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
;(dbExecute as any).mockResolvedValueOnce([])
        // Then for s2 (no route — random kind)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
;(dbExecute as any).mockResolvedValueOnce([{
            id: 's2', workspace_id: 'w1', kind: 'unknown',
            payload: {}, score: 2, status: 'pending',
        }])

        const r = await autoPromoteAboveThreshold({ workspaceId: 'w1' })
        expect(r.inspected).toBe(2)
        expect(r.promoted).toBe(1)
        expect(r.noRoute).toBe(1)
    })
})
