// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2a — agent-side cost gate decision tests.
 *
 * Same shape as the apps/api cost-enforcement test but pinned against
 * the executor-side `decideAgentCost` so a regression in either copy
 * surfaces independently. The two helpers must agree on:
 *   - 80% / 100% thresholds
 *   - hard_block returning state=block + 402-ready error
 *   - missing/zero/negative ceiling = no ceiling
 */

import { describe, it, expect } from 'vitest'
import {
    decideAgentCost,
    decideTaskDowngrade,
    CostCeilingExceededError,
    type AgentSpendSnapshot,
} from '../cost-gate.js'

function spend(usd: number): AgentSpendSnapshot {
    return {
        pricedUsd: usd,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        monthStart: new Date().toISOString(),
        computedAt: new Date().toISOString(),
    }
}

describe('decideAgentCost', () => {
    it('passes when no ceiling is set', () => {
        const d = decideAgentCost({}, spend(99))
        expect(d.state).toBe('ok')
        expect(d.ceilingUsd).toBeNull()
    })

    it('passes when below 80%', () => {
        const d = decideAgentCost({ costCeilingUsd: 100 }, spend(40))
        expect(d.state).toBe('ok')
    })

    it('warns at 80%-99% in any mode', () => {
        const soft = decideAgentCost({ costCeilingUsd: 100, costCeilingMode: 'soft_warn' }, spend(85))
        const hard = decideAgentCost({ costCeilingUsd: 100, costCeilingMode: 'hard_block' }, spend(85))
        expect(soft.state).toBe('warn')
        expect(hard.state).toBe('warn')
    })

    it('warns at 100% in soft mode', () => {
        const d = decideAgentCost({ costCeilingUsd: 50, costCeilingMode: 'soft_warn' }, spend(60))
        expect(d.state).toBe('warn')
        if (d.state === 'warn') expect(d.reason).toBe('soft_warn_100')
    })

    it('blocks at 100% in hard mode', () => {
        const d = decideAgentCost({ costCeilingUsd: 50, costCeilingMode: 'hard_block' }, spend(60))
        expect(d.state).toBe('block')
        if (d.state === 'block') expect(d.reason).toBe('hard_block_100')
    })

    it('treats zero/negative ceilings as no ceiling', () => {
        expect(decideAgentCost({ costCeilingUsd: 0 }, spend(10)).state).toBe('ok')
        expect(decideAgentCost({ costCeilingUsd: -1 }, spend(10)).state).toBe('ok')
    })
})

describe('CostCeilingExceededError', () => {
    it('exposes statusCode 402 and a message with the financials', () => {
        const err = new CostCeilingExceededError('ws-X', 100, 110, 1.1)
        expect(err.statusCode).toBe(402)
        expect(err.code).toBe('COST_CEILING_EXCEEDED')
        expect(err.workspaceId).toBe('ws-X')
        expect(err.ceilingUsd).toBe(100)
        expect(err.spentUsd).toBe(110)
        expect(err.message).toContain('110%')
    })
})

describe('decideTaskDowngrade (B11)', () => {
    it('not engaged when no ceiling', () => {
        expect(decideTaskDowngrade(50, null).engaged).toBe(false)
        expect(decideTaskDowngrade(50, 0).engaged).toBe(false)
        expect(decideTaskDowngrade(50, -1).engaged).toBe(false)
    })

    it('not engaged below 80%', () => {
        expect(decideTaskDowngrade(0.79, 1).engaged).toBe(false)
        expect(decideTaskDowngrade(0, 10).usagePct).toBe(0)
    })

    it('engaged at/between 80% and 100%', () => {
        const at = decideTaskDowngrade(0.8, 1)
        expect(at.engaged).toBe(true)
        expect(at.usagePct).toBeCloseTo(0.8, 5)
        const mid = decideTaskDowngrade(0.95, 1)
        expect(mid.engaged).toBe(true)
        expect(mid.usagePct).toBeCloseTo(0.95, 5)
    })

    it('not engaged at/above 100% (the hard block owns that zone)', () => {
        const at = decideTaskDowngrade(1, 1)
        expect(at.engaged).toBe(false)
        const over = decideTaskDowngrade(1.2, 1)
        expect(over.engaged).toBe(false)
        expect(over.usagePct).toBeGreaterThan(1)
    })
})
