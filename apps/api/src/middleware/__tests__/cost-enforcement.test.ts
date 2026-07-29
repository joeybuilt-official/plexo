// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2a — cost enforcement decision tests.
 *
 * Pinned tests for the pure decideCostCeiling helper across the four
 * meaningful cases:
 *   1. No ceiling set → state ok
 *   2. Below 80% → state ok
 *   3. 80-99% → state warn (regardless of mode)
 *   4. >=100% in soft_warn → state warn
 *   5. >=100% in hard_block → state block
 *
 * Plus a guard that the executor-side helper throws CostCeilingExceededError
 * with the correct fields when hard-blocked.
 */

import { describe, it, expect } from 'vitest'
import { decideCostCeiling, CostCeilingExceededError } from '../cost-enforcement.js'
import type { WorkspaceSpend } from '../../lib/intelligence-spend.js'

function spend(usd: number): WorkspaceSpend {
    return {
        workspaceId: 'ws-1',
        monthStart: new Date().toISOString(),
        pricedUsd: usd,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        unpricedInputTokens: 0,
        unpricedOutputTokens: 0,
        computedAt: new Date().toISOString(),
    }
}

describe('decideCostCeiling', () => {
    it('returns ok when no ceiling is configured', () => {
        const d = decideCostCeiling({}, spend(50))
        expect(d.state).toBe('ok')
        expect(d.ceilingUsd).toBeNull()
    })

    it('returns ok when usage is below 80%', () => {
        const d = decideCostCeiling({ costCeilingUsd: 100 }, spend(40))
        expect(d.state).toBe('ok')
        expect(d.usagePct).toBeCloseTo(0.4)
    })

    it('returns warn(80) at 80%-99% in soft mode', () => {
        const d = decideCostCeiling({ costCeilingUsd: 100, costCeilingMode: 'soft_warn' }, spend(85))
        expect(d.state).toBe('warn')
        if (d.state === 'warn') expect(d.reason).toBe('soft_warn_80')
    })

    it('returns warn(80) at 80% in hard mode too — only hard-blocks at 100%', () => {
        const d = decideCostCeiling({ costCeilingUsd: 100, costCeilingMode: 'hard_block' }, spend(85))
        expect(d.state).toBe('warn')
        if (d.state === 'warn') expect(d.reason).toBe('soft_warn_80')
    })

    it('returns warn(100) at >=100% when mode is soft_warn', () => {
        const d = decideCostCeiling({ costCeilingUsd: 100, costCeilingMode: 'soft_warn' }, spend(120))
        expect(d.state).toBe('warn')
        if (d.state === 'warn') expect(d.reason).toBe('soft_warn_100')
    })

    it('returns block at >=100% when mode is hard_block', () => {
        const d = decideCostCeiling({ costCeilingUsd: 50, costCeilingMode: 'hard_block' }, spend(50))
        expect(d.state).toBe('block')
        if (d.state === 'block') {
            expect(d.reason).toBe('hard_block_100')
            expect(d.ceilingUsd).toBe(50)
        }
    })

    it('treats negative or zero ceiling as no ceiling', () => {
        expect(decideCostCeiling({ costCeilingUsd: 0 }, spend(10)).state).toBe('ok')
        expect(decideCostCeiling({ costCeilingUsd: -5 }, spend(10)).state).toBe('ok')
    })

    it('defaults to soft_warn when mode is unset', () => {
        const d = decideCostCeiling({ costCeilingUsd: 10 }, spend(10))
        expect(d.state).toBe('warn')
        if (d.state === 'warn') expect(d.reason).toBe('soft_warn_100')
    })
})

describe('CostCeilingExceededError', () => {
    it('captures the workspace + financials and uses 402', () => {
        const err = new CostCeilingExceededError('ws-1', 25, 30, 1.2)
        expect(err.code).toBe('COST_CEILING_EXCEEDED')
        expect(err.statusCode).toBe(402)
        expect(err.message).toContain('ws-1')
        expect(err.message).toContain('$30.0000')
        expect(err.message).toContain('$25.00')
        expect(err.message).toContain('120%')
    })
})
