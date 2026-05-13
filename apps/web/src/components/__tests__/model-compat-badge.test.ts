// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Pure-logic tests for the model-compat badge helpers. The web test surface
// runs under node and does not execute JSX, so we exercise the exported
// helpers directly. Component rendering is covered by Playwright e2e.

import { describe, it, expect } from 'vitest'

import {
    pickStatusKind,
    formatRelativeValidatedAt,
    statusCopyFor,
    KNOWN_COMPATIBLE_MODELS,
} from '../model-compat-badge'

describe('pickStatusKind', () => {
    it('maps native/repair/failed verbatim', () => {
        expect(pickStatusKind('native')).toBe('native')
        expect(pickStatusKind('repair')).toBe('repair')
        expect(pickStatusKind('failed')).toBe('failed')
    })

    it('maps null and undefined to "unchecked"', () => {
        expect(pickStatusKind(null)).toBe('unchecked')
        expect(pickStatusKind(undefined)).toBe('unchecked')
    })
})

describe('formatRelativeValidatedAt', () => {
    const now = new Date('2026-05-03T12:00:00Z')

    it('returns null for null/undefined/invalid', () => {
        expect(formatRelativeValidatedAt(null, now)).toBeNull()
        expect(formatRelativeValidatedAt(undefined, now)).toBeNull()
        expect(formatRelativeValidatedAt('not-a-date', now)).toBeNull()
    })

    it('returns "just now" for sub-minute and future timestamps', () => {
        expect(formatRelativeValidatedAt('2026-05-03T11:59:30Z', now)).toBe('just now')
        expect(formatRelativeValidatedAt('2026-05-03T12:30:00Z', now)).toBe('just now')
    })

    it('formats minutes', () => {
        expect(formatRelativeValidatedAt('2026-05-03T11:55:00Z', now))
            .toBe('validated 5 minutes ago')
        expect(formatRelativeValidatedAt('2026-05-03T11:59:00Z', now))
            .toBe('validated 1 minute ago')
    })

    it('formats hours', () => {
        expect(formatRelativeValidatedAt('2026-05-03T09:00:00Z', now))
            .toBe('validated 3 hours ago')
        expect(formatRelativeValidatedAt('2026-05-03T11:00:00Z', now))
            .toBe('validated 1 hour ago')
    })

    it('formats days', () => {
        expect(formatRelativeValidatedAt('2026-04-30T12:00:00Z', now))
            .toBe('validated 3 days ago')
    })

    it('formats months and years', () => {
        expect(formatRelativeValidatedAt('2026-02-01T12:00:00Z', now))
            .toMatch(/validated \d+ months? ago/)
        expect(formatRelativeValidatedAt('2024-05-03T12:00:00Z', now))
            .toMatch(/validated \d+ years? ago/)
    })
})

describe('statusCopyFor', () => {
    it('returns distinct copy for each kind', () => {
        const seen = new Set<string>()
        for (const k of ['native', 'repair', 'failed', 'unchecked'] as const) {
            const c = statusCopyFor(k)
            expect(c.title.length).toBeGreaterThan(0)
            expect(c.body.length).toBeGreaterThan(0)
            expect(c.ariaLabel).toContain('Model compatibility status')
            seen.add(c.title)
        }
        expect(seen.size).toBe(4)
    })

    it('failed copy mentions structured output (so users know what broke)', () => {
        expect(statusCopyFor('failed').body.toLowerCase()).toContain('structured output')
    })

    it('repair copy reassures (does not alarm)', () => {
        expect(statusCopyFor('repair').body.toLowerCase()).toContain('work around')
    })
})

describe('KNOWN_COMPATIBLE_MODELS', () => {
    it('is non-empty and well-formed', () => {
        expect(KNOWN_COMPATIBLE_MODELS.length).toBeGreaterThan(0)
        for (const m of KNOWN_COMPATIBLE_MODELS) {
            expect(m.provider.length).toBeGreaterThan(0)
            expect(m.model.length).toBeGreaterThan(0)
        }
    })

    it('includes Anthropic + OpenAI flagships (the safe defaults)', () => {
        const providers = KNOWN_COMPATIBLE_MODELS.map(m => m.provider)
        expect(providers).toContain('Anthropic')
        expect(providers).toContain('OpenAI')
    })
})
