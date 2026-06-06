// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { buildCapabilityLimitationSummary, decideCapabilityGapOutcome } from './index.js'

describe('buildCapabilityLimitationSummary (Phase N)', () => {
    it('produces an honest completed-with-limitation note', () => {
        const s = buildCapabilityLimitationSummary('No such tool: deploy_site')
        expect(s).toMatch(/Completed with a limitation/i)
        expect(s).toMatch(/produced the deliverable/i)
        // names the shape of the missing capability without over-claiming success
        expect(s).toMatch(/deploy|host/i)
    })

    it('appends a bounded detail from the error message', () => {
        const s = buildCapabilityLimitationSummary('No such tool: deploy_site')
        expect(s).toContain('Detail: No such tool: deploy_site')
    })

    it('caps the detail length (no unbounded error text leak)', () => {
        const long = 'x'.repeat(1000)
        const s = buildCapabilityLimitationSummary(long)
        // detail is sliced to 200 chars
        expect(s).toContain('Detail: ' + 'x'.repeat(200))
        expect(s).not.toContain('x'.repeat(201))
    })

    it('omits the detail clause when the message is empty', () => {
        const s = buildCapabilityLimitationSummary('')
        expect(s).not.toContain('Detail:')
    })
})

describe('decideCapabilityGapOutcome (Phase N wired throw→catch decision)', () => {
    it('completes with limitation when a capability-worded throw has a deliverable', () => {
        expect(decideCapabilityGapOutcome('No such tool: deploy_site', true)).toBe('complete_with_limitation')
        expect(decideCapabilityGapOutcome('I cannot deploy this site', true)).toBe('complete_with_limitation')
        expect(decideCapabilityGapOutcome('no integration configured', true)).toBe('complete_with_limitation')
    })

    it('re-throws a capability gap with NO deliverable (→ fail capability_unavailable, Slice 1)', () => {
        expect(decideCapabilityGapOutcome('No such tool: deploy_site', false)).toBe('rethrow')
    })

    it('re-throws a real crash even with a deliverable (→ tool_error)', () => {
        // non-capability-worded message must never be downgraded to a graceful complete
        expect(decideCapabilityGapOutcome('database connection reset by peer', true)).toBe('rethrow')
        expect(decideCapabilityGapOutcome('Task stalled: no progress', true)).toBe('rethrow')
    })

    it('re-throws a real crash with no deliverable', () => {
        expect(decideCapabilityGapOutcome('database connection reset by peer', false)).toBe('rethrow')
    })
})
