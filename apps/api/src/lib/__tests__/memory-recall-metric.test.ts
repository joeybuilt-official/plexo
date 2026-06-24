// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * QA-opt: proves the memory-recall observability counter (ADR 0042) registers,
 * increments per outcome, and renders in Prometheus exposition. Catches the
 * regression where a budget_exceeded recall (graphiti jammed → memoryless reply)
 * was previously invisible (debug-log only).
 */
import { describe, it, expect } from 'vitest'
import { recordMemoryRecall, recordModelRouted, recordMemoryWrite, getCounterSeries, render } from '../metrics.js'

describe('plexo_memory_recall_total', () => {
    it('increments per result label and renders', () => {
        const before = (label: string) =>
            getCounterSeries('plexo_memory_recall_total').find(s => s.labels.result === label)?.value ?? 0

        const hitBefore = before('hit')
        const budgetBefore = before('budget_exceeded')

        recordMemoryRecall('hit')
        recordMemoryRecall('budget_exceeded')
        recordMemoryRecall('budget_exceeded')
        recordMemoryRecall('miss')
        recordMemoryRecall('error')

        const after = (label: string) =>
            getCounterSeries('plexo_memory_recall_total').find(s => s.labels.result === label)?.value ?? 0

        expect(after('hit')).toBe(hitBefore + 1)
        expect(after('budget_exceeded')).toBe(budgetBefore + 2)
        expect(after('miss')).toBeGreaterThanOrEqual(1)
        expect(after('error')).toBeGreaterThanOrEqual(1)

        const text = render()
        expect(text).toContain('plexo_memory_recall_total')
        expect(text).toContain('result="budget_exceeded"')
    })

    it('plexo_model_routed_total increments with decision labels', () => {
        recordModelRouted({ taskType: 'extraction', fallback: true, degraded: false, operatorAction: false })
        const s = getCounterSeries('plexo_model_routed_total').find(
            x => x.labels.task_type === 'extraction' && x.labels.fallback === '1',
        )
        expect(s?.value).toBeGreaterThanOrEqual(1)
        expect(render()).toContain('plexo_model_routed_total')
    })

    it('plexo_memory_write_total classifies extracted/empty/failed', () => {
        recordMemoryWrite({ graphitiOk: true, extractedFacts: 3 })   // extracted
        recordMemoryWrite({ graphitiOk: true, extractedFacts: 0 })   // empty (silent loss)
        recordMemoryWrite({ graphitiOk: false, extractedFacts: null }) // failed
        const val = (r: string) => getCounterSeries('plexo_memory_write_total').find(x => x.labels.result === r)?.value ?? 0
        expect(val('extracted')).toBeGreaterThanOrEqual(1)
        expect(val('empty')).toBeGreaterThanOrEqual(1)
        expect(val('failed')).toBeGreaterThanOrEqual(1)
    })
})
