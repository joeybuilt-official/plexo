// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { buildCapabilityLimitationSummary } from './index.js'

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
