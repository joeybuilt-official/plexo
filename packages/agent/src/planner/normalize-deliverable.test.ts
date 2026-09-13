// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Post-planner normalization: a single-step, tool-less deliverable plan must
 * gain `write_asset`, or the executor strips every tool and the user gets no
 * artifact/link for "make me X".
 */
import { describe, it, expect } from 'vitest'
import { normalizeDeliverableTools } from './index.js'
import type { PlanStep } from '../types.js'

const step = (toolsRequired: string[] = []): PlanStep => ({
    stepNumber: 1,
    description: 'do it',
    toolsRequired,
    verificationMethod: 'Review output',
    isOneWayDoor: false,
})

describe('normalizeDeliverableTools', () => {
    it('adds write_asset to a tool-less deliverable plan', () => {
        const out = normalizeDeliverableTools([step()], 'make a snake game')
        expect(out).toHaveLength(1)
        expect(out[0]!.toolsRequired).toEqual(['write_asset'])
    })

    it('leaves a tool-less conversational plan alone', () => {
        const out = normalizeDeliverableTools([step()], 'tell me a joke')
        expect(out[0]!.toolsRequired).toEqual([])
    })

    it('does not touch a plan that already declares tools', () => {
        const out = normalizeDeliverableTools([step(['read_file'])], 'make a game')
        expect(out[0]!.toolsRequired).toEqual(['read_file'])
    })

    it('does not touch multi-step plans', () => {
        const steps: PlanStep[] = [step(), { ...step(), stepNumber: 2 }]
        const out = normalizeDeliverableTools(steps, 'make a game')
        expect(out.map(s => s.toolsRequired)).toEqual([[], []])
    })
})
