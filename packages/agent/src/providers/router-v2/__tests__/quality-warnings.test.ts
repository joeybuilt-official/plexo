// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
    RECOMMENDED_PRIOR,
    recordDegradation,
    getQualityWarning,
    getQualityWarningsAll,
    _resetQualityWarningsForTest,
} from '../quality-warnings.js'

describe('router-v2 quality-warnings', () => {
    beforeEach(() => {
        _resetQualityWarningsForTest()
    })

    it('RECOMMENDED_PRIOR is 4 (ADR 0012 §C6 Q2 threshold)', () => {
        expect(RECOMMENDED_PRIOR).toBe(4)
    })

    it('records nothing when priorScore ≥ RECOMMENDED_PRIOR', () => {
        recordDegradation({ workspaceId: 'ws-1', taskType: 'planning', provider: 'anthropic', priorScore: 5 })
        recordDegradation({ workspaceId: 'ws-1', taskType: 'planning', provider: 'openai', priorScore: 4 })
        const w = getQualityWarning('ws-1', 'planning')
        expect(w.count).toBe(0)
        expect(w.lastAt).toBe(0)
    })

    it('records when priorScore < RECOMMENDED_PRIOR', () => {
        recordDegradation({ workspaceId: 'ws-1', taskType: 'planning', provider: 'groq', priorScore: 2 })
        const w = getQualityWarning('ws-1', 'planning')
        expect(w.count).toBe(1)
        expect(w.lastPriorScore).toBe(2)
        expect(w.lastProvider).toBe('groq')
        expect(w.lastAt).toBeGreaterThan(0)
    })

    it('aggregates count over multiple events', () => {
        for (let i = 0; i < 5; i++) {
            recordDegradation({ workspaceId: 'ws-1', taskType: 'extraction', provider: 'deepseek', priorScore: 3 })
        }
        expect(getQualityWarning('ws-1', 'extraction').count).toBe(5)
    })

    it('7-day window trims older samples on read', () => {
        const realNow = Date.now
        try {
            const t0 = 1_700_000_000_000
            Date.now = vi.fn(() => t0)
            recordDegradation({ workspaceId: 'ws-1', taskType: 'classification', provider: 'groq', priorScore: 3 })
            recordDegradation({ workspaceId: 'ws-1', taskType: 'classification', provider: 'groq', priorScore: 3 })
            // Jump 8 days; both should be trimmed.
            Date.now = vi.fn(() => t0 + 8 * 24 * 60 * 60 * 1000)
            const w = getQualityWarning('ws-1', 'classification')
            expect(w.count).toBe(0)
        } finally {
            Date.now = realNow
        }
    })

    it('getQualityWarningsAll returns all degraded tasks for a workspace, sorted by count desc', () => {
        for (let i = 0; i < 3; i++) {
            recordDegradation({ workspaceId: 'ws-1', taskType: 'planning', provider: 'groq', priorScore: 2 })
        }
        recordDegradation({ workspaceId: 'ws-1', taskType: 'extraction', provider: 'deepseek', priorScore: 3 })
        // Different workspace — should not leak.
        recordDegradation({ workspaceId: 'ws-2', taskType: 'planning', provider: 'groq', priorScore: 2 })

        const all = getQualityWarningsAll('ws-1')
        expect(all).toHaveLength(2)
        expect(all[0]!.taskType).toBe('planning')
        expect(all[0]!.count).toBe(3)
        expect(all[1]!.taskType).toBe('extraction')
        expect(all[1]!.count).toBe(1)
    })

    it('workspace isolation — ws-1 and ws-2 are independent', () => {
        recordDegradation({ workspaceId: 'ws-1', taskType: 'planning', provider: 'groq', priorScore: 2 })
        recordDegradation({ workspaceId: 'ws-2', taskType: 'planning', provider: 'groq', priorScore: 2 })
        expect(getQualityWarning('ws-1', 'planning').count).toBe(1)
        expect(getQualityWarning('ws-2', 'planning').count).toBe(1)
        expect(getQualityWarningsAll('ws-1')).toHaveLength(1)
        expect(getQualityWarningsAll('ws-2')).toHaveLength(1)
    })
})
