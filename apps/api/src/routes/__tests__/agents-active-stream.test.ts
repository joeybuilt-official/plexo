// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import {
    buildAgentsSnapshot,
    nextPollCadence,
    ACTIVE_STATUSES,
    type ActiveTaskRow,
    type LatestStep,
} from '../agents-active-stream.js'

const task = (over: Partial<ActiveTaskRow> = {}): ActiveTaskRow => ({
    id: 't1',
    role: 'coding',
    status: 'running',
    parentId: null,
    outcomeSummary: null,
    ...over,
})

const step = (over: Partial<LatestStep> = {}): LatestStep => ({
    stepNumber: 3,
    stepType: 'execute',
    state: 'running',
    outcome: 'wrote file',
    error: null,
    ...over,
})

describe('buildAgentsSnapshot', () => {
    it('returns [] for no active tasks', () => {
        expect(buildAgentsSnapshot([], new Map())).toEqual([])
    })

    it('maps role/status/parentId and the latest step summary', () => {
        const [first] = buildAgentsSnapshot([task({ parentId: 'p1' })], new Map([['t1', step()]]))
        expect(first).toMatchObject({ id: 't1', role: 'coding', status: 'running', parentId: 'p1' })
        expect(first?.step).toEqual({ stepNumber: 3, stepType: 'execute', state: 'running', summary: 'wrote file' })
    })

    it('emits step: null when the task has no steps yet', () => {
        const [first] = buildAgentsSnapshot([task()], new Map())
        expect(first?.step).toBeNull()
    })

    it('prefers error over outcome in the summary', () => {
        const [first] = buildAgentsSnapshot([task()], new Map([['t1', step({ error: 'boom', outcome: 'ignored' })]]))
        expect(first?.step?.summary).toBe('boom')
    })

    it('truncates the step summary to 160 chars', () => {
        const long = 'x'.repeat(500)
        const [first] = buildAgentsSnapshot([task()], new Map([['t1', step({ outcome: long, error: null })]]))
        expect(first?.step?.summary).toHaveLength(160)
    })

    it('exposes only non-terminal active statuses', () => {
        expect([...ACTIVE_STATUSES]).toEqual(['queued', 'claimed', 'running'])
        expect(ACTIVE_STATUSES).not.toContain('complete')
        expect(ACTIVE_STATUSES).not.toContain('failed')
    })
})

describe('nextPollCadence', () => {
    it('snaps back to 2s base whenever agents are active', () => {
        expect(nextPollCadence(1, 10_000)).toBe(2000)
        expect(nextPollCadence(5, 8000)).toBe(2000)
    })

    it('backs off 1.5× while idle', () => {
        expect(nextPollCadence(0, 2000)).toBe(3000)
        expect(nextPollCadence(0, 3000)).toBe(4500)
    })

    it('clamps the idle backoff at 10s', () => {
        expect(nextPollCadence(0, 8000)).toBe(10_000)
        expect(nextPollCadence(0, 10_000)).toBe(10_000)
    })
})
