// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Lock down the routing rule for the "Continue conversation" icon in the
// conversations list. Bug class this guards against: the click handler
// dropping the user into a fresh chat (e.g., using `item.id` where
// `item.sessionId` belongs, or vice versa). The chat page addresses a
// session via the ?sessionId= query param; only legacy rows without a
// sessionId fall back to ?context=<row-id>.

import { describe, it, expect } from 'vitest'

import { continueHref } from '../conversations-list'

describe('continueHref', () => {
    it('routes by sessionId when present (the canonical thread continuation)', () => {
        const href = continueHref({ id: '01HXYZROW', sessionId: 'sess_abc123' })
        expect(href).toBe('/app/chat?sessionId=sess_abc123')
    })

    it('falls back to the row id only when sessionId is null (legacy row)', () => {
        const href = continueHref({ id: '01HXYZROW', sessionId: null })
        expect(href).toBe('/app/chat?context=01HXYZROW')
    })

    it('never uses the row id when a sessionId exists — guards against id↔sessionId swap', () => {
        const href = continueHref({ id: '01HXYZROW', sessionId: 'sess_abc123' })
        expect(href).not.toContain('01HXYZROW')
        expect(href).not.toContain('context=')
    })

    it('never points to an unconditionally-fresh chat URL', () => {
        // Regression: previously, an empty/wrong sessionId would silently
        // bail and land the user on a blank /app/chat. The href itself must
        // always address either a session or a single conversation row.
        const withSession = continueHref({ id: 'r1', sessionId: 'sess_1' })
        const withoutSession = continueHref({ id: 'r1', sessionId: null })
        expect(withSession).not.toBe('/app/chat')
        expect(withoutSession).not.toBe('/app/chat')
        expect(withSession).not.toMatch(/\?new=/)
        expect(withoutSession).not.toMatch(/\?new=/)
    })

    it('URL-encodes the sessionId so values with reserved chars round-trip safely', () => {
        const href = continueHref({ id: 'r1', sessionId: 'sess with space & =' })
        expect(href).toBe(`/app/chat?sessionId=${encodeURIComponent('sess with space & =')}`)
    })

    it('URL-encodes the context id in the fallback path', () => {
        const href = continueHref({ id: 'row/with?weird=chars', sessionId: null })
        expect(href).toBe(`/app/chat?context=${encodeURIComponent('row/with?weird=chars')}`)
    })
})
