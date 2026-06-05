// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { OneWayDoorSchema } from '../planner/index.js'

// Weak models emit partial one-way-door objects. Previously a missing `type`
// or `reversibility` failed the whole union (invalid_union) → the entire plan
// parse threw → task.failed. These coercions keep the task alive while failing
// CLOSED on the safety-critical `requiresApproval` field.
describe('OneWayDoorSchema — safe coercion', () => {
    it('partial object (missing type/reversibility/requiresApproval) → safe defaults, fail closed', () => {
        const r = OneWayDoorSchema.parse({ description: 'drop the production users table' })
        expect(r).toEqual({
            description: 'drop the production users table',
            type: 'state_change',
            reversibility: 'unknown',
            requiresApproval: true, // fail closed
        })
    })

    it('missing requiresApproval defaults to true (never silently un-gated)', () => {
        const r = OneWayDoorSchema.parse({ description: 'irreversible deploy to prod', type: 'destructive' }) as { requiresApproval: boolean }
        expect(r.requiresApproval).toBe(true)
    })

    it('invalid type coerces to state_change (not a parse failure)', () => {
        const r = OneWayDoorSchema.parse({ description: 'some op here', type: 'frobnicate' }) as { type: string }
        expect(r.type).toBe('state_change')
    })

    it('well-formed object passes through unchanged', () => {
        const input = { description: 'send the launch email', type: 'external_call' as const, reversibility: 'irreversible', requiresApproval: true }
        expect(OneWayDoorSchema.parse(input)).toEqual(input)
    })

    it('bare string → safe one-way-door', () => {
        const r = OneWayDoorSchema.parse('delete the staging database') as { requiresApproval: boolean; type: string }
        expect(r.requiresApproval).toBe(true)
        expect(r.type).toBe('state_change')
    })

    it('bare number → null (dropped; uninformative)', () => {
        expect(OneWayDoorSchema.parse(4)).toBeNull()
    })
})
