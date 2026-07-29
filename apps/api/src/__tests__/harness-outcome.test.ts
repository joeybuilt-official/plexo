// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase C — Outcome capture payload construction
 *
 * Tests buildOutcomePayload pure function.
 * DB layer is stubbed in outcome-capture.ts until migration 0122 is applied.
 */

import { describe, it, expect } from 'vitest'
import { buildOutcomePayload } from '../outcome-capture.js'

const TASK_ID = 'task_aaaa'
const ROUTINE_ID = 'bbbbbbbb-0000-0000-0000-000000000001'

describe('buildOutcomePayload', () => {
    it('cron task with cronJobId → routineId set', () => {
        const p = buildOutcomePayload({
            taskId: TASK_ID,
            taskSource: 'cron',
            context: { cronJobId: ROUTINE_ID },
            outcomeSummary: 'Checked 3 PRs, no action needed.',
            automatedOutcome: 'complete',
        })
        expect(p.routineId).toBe(ROUTINE_ID)
        expect(p.trigger).toBe('cron')
        expect(p.taskId).toBe(TASK_ID)
        expect(p.summary).toBe('Checked 3 PRs, no action needed.')
        expect(p.automatedOutcome).toBe('complete')
    })

    it('standalone user task → no routineId', () => {
        const p = buildOutcomePayload({
            taskId: TASK_ID,
            taskSource: 'user',
            context: {},
            outcomeSummary: 'Done.',
            automatedOutcome: 'complete',
        })
        expect(p.routineId).toBeUndefined()
        expect(p.trigger).toBe('user')
    })

    it('summary truncated at 2000 chars', () => {
        const long = 'x'.repeat(3000)
        const p = buildOutcomePayload({
            taskId: TASK_ID,
            taskSource: 'cron',
            context: null,
            outcomeSummary: long,
            automatedOutcome: 'complete',
        })
        expect(p.summary?.length).toBe(2000)
    })

    it('undefined summary → undefined in payload', () => {
        const p = buildOutcomePayload({
            taskId: TASK_ID,
            taskSource: 'github',
            context: null,
            outcomeSummary: undefined,
            automatedOutcome: 'failed',
        })
        expect(p.summary).toBeUndefined()
    })

    it('automatedOutcome forwarded', () => {
        const p = buildOutcomePayload({
            taskId: TASK_ID,
            taskSource: 'telegram',
            context: {},
            outcomeSummary: 'Done.',
            automatedOutcome: 'cost_ceiling',
        })
        expect(p.automatedOutcome).toBe('cost_ceiling')
    })

    it('null/undefined source → trigger="unknown"', () => {
        const p = buildOutcomePayload({
            taskId: TASK_ID,
            taskSource: null,
            context: {},
            outcomeSummary: '',
            automatedOutcome: 'complete',
        })
        expect(p.trigger).toBe('unknown')
    })
})
