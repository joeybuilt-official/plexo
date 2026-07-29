// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { buildRevisionView, type RevisionRow, type SourceOutcome } from '../revision-decision.js'

const row = (over: Partial<RevisionRow> = {}): RevisionRow => ({
    id: 'rev1',
    routineId: 'routine1',
    routineName: 'Daily digest',
    version: 3,
    proposedDiff: '- old\n+ new',
    rationale: 'because',
    sourceOutcomeIds: ['o1', 'o2'],
    expiresAt: null,
    ...over,
})

const oc = (id: string): SourceOutcome => ({ id, summary: `s-${id}`, automatedOutcome: 'complete', humanVerdict: null })

describe('buildRevisionView', () => {
    it('resolves source outcome ids to outcome objects, in order', () => {
        const view = buildRevisionView(row(), new Map([['o1', oc('o1')], ['o2', oc('o2')]]))
        expect(view.sourceOutcomes.map((o) => o.id)).toEqual(['o1', 'o2'])
        expect(view).toMatchObject({ id: 'rev1', routineName: 'Daily digest', version: 3, proposedDiff: '- old\n+ new' })
        expect('sourceOutcomeIds' in view).toBe(false)
    })

    it('drops ids with no matching outcome (no nulls leak through)', () => {
        const view = buildRevisionView(row({ sourceOutcomeIds: ['o1', 'missing'] }), new Map([['o1', oc('o1')]]))
        expect(view.sourceOutcomes).toHaveLength(1)
        expect(view.sourceOutcomes[0]?.id).toBe('o1')
    })

    it('handles a revision with no source outcomes', () => {
        const view = buildRevisionView(row({ sourceOutcomeIds: [] }), new Map())
        expect(view.sourceOutcomes).toEqual([])
    })
})
