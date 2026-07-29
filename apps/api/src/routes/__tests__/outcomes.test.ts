// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { buildOutcomesView, type OutcomeRow, type LinkedLesson } from '../outcomes.js'

const row = (over: Partial<OutcomeRow> = {}): OutcomeRow => ({
    id: 'o1',
    ts: new Date('2026-06-01T00:00:00Z'),
    trigger: 'cron',
    summary: 'sent the digest',
    routineId: 'r1',
    routineName: 'Daily digest',
    taskId: 't1',
    taskType: 'cron',
    taskStatus: 'completed',
    automatedOutcome: 'complete',
    humanVerdict: null,
    ...over,
})

const lesson = (over: Partial<LinkedLesson> = {}): LinkedLesson => ({
    revisionId: 'rev1',
    routineId: 'r1',
    version: 2,
    status: 'pending',
    rationale: 'tighten the summary',
    ...over,
})

describe('buildOutcomesView — verdict pairing', () => {
    it('passes the automated/human pair straight through', () => {
        const v = (buildOutcomesView([row({ automatedOutcome: 'complete', humanVerdict: 'accept' })], new Map()))[0]!
        expect(v).toMatchObject({ automatedOutcome: 'complete', humanVerdict: 'accept' })
    })
})

describe('buildOutcomesView — disagreement flag', () => {
    it('flags automated success vs human reject', () => {
        const v = (buildOutcomesView([row({ automatedOutcome: 'complete', humanVerdict: 'reject' })], new Map()))[0]!
        expect(v.disagreement).toBe(true)
    })

    it('flags automated failure vs human accept', () => {
        const v = (buildOutcomesView([row({ automatedOutcome: 'failed', humanVerdict: 'accept' })], new Map()))[0]!
        expect(v.disagreement).toBe(true)
    })

    it('does not flag when both agree', () => {
        const v = (buildOutcomesView([row({ automatedOutcome: 'complete', humanVerdict: 'accept' })], new Map()))[0]!
        expect(v.disagreement).toBe(false)
    })

    it('does not flag when the human verdict is missing', () => {
        const v = (buildOutcomesView([row({ automatedOutcome: 'complete', humanVerdict: null })], new Map()))[0]!
        expect(v.disagreement).toBe(false)
    })

    it('does not flag on an unknown automated value', () => {
        const v = (buildOutcomesView([row({ automatedOutcome: 'weird', humanVerdict: 'reject' })], new Map()))[0]!
        expect(v.disagreement).toBe(false)
    })
})

describe('buildOutcomesView — linked lessons', () => {
    it('attaches lessons distilled from the outcome', () => {
        const map = new Map<string, LinkedLesson[]>([['o1', [lesson()]]])
        const v = (buildOutcomesView([row({ id: 'o1' })], map))[0]!
        expect(v.lessons).toHaveLength(1)
        expect(v.lessons[0]?.revisionId).toBe('rev1')
    })

    it('is empty when no lesson references the outcome (distill off)', () => {
        const v = (buildOutcomesView([row({ id: 'o1' })], new Map()))[0]!
        expect(v.lessons).toEqual([])
    })
})

describe('buildOutcomesView — empty input', () => {
    it('returns an empty list', () => {
        expect(buildOutcomesView([], new Map())).toEqual([])
    })
})
