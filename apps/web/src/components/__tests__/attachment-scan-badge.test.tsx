// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Pure-logic tests for the attachment-scan badge helpers. The web test
// surface runs under node and does not execute JSX, so we exercise the
// exported helpers directly. Component rendering is covered by Playwright
// e2e (Phase N+1 follow-up).

import { describe, it, expect } from 'vitest'

import {
    badgeConfigFor,
    tooltipFor,
    type ScanStatus,
} from '../attachment-scan-badge'

describe('badgeConfigFor', () => {
    it('renders distinct label + icon class for each of the 5 states', () => {
        const states: ScanStatus[] = ['unscanned', 'scanning', 'clean', 'infected', 'error']
        const labels = new Set<string>()
        for (const s of states) {
            const cfg = badgeConfigFor(s)
            expect(cfg.label.length).toBeGreaterThan(0)
            expect(cfg.iconClass.length).toBeGreaterThan(0)
            expect(cfg.containerClass.length).toBeGreaterThan(0)
            labels.add(cfg.label)
        }
        expect(labels.size).toBe(5)
    })

    it('unscanned → neutral gray "Not scanned"', () => {
        const cfg = badgeConfigFor('unscanned')
        expect(cfg.label).toBe('Not scanned')
        expect(cfg.iconClass).toContain('text-zinc-400')
        expect(cfg.spin).toBe(false)
    })

    it('scanning → spinner enabled with "Scanning…"', () => {
        const cfg = badgeConfigFor('scanning')
        expect(cfg.label).toBe('Scanning…')
        expect(cfg.spin).toBe(true)
    })

    it('clean → emerald token + "Clean"', () => {
        const cfg = badgeConfigFor('clean')
        expect(cfg.label).toBe('Clean')
        expect(cfg.iconClass).toContain('text-signal-green')
        expect(cfg.spin).toBe(false)
    })

    it('infected → red token + "Infected"', () => {
        const cfg = badgeConfigFor('infected')
        expect(cfg.label).toBe('Infected')
        expect(cfg.iconClass).toContain('text-red-500')
        expect(cfg.spin).toBe(false)
    })

    it('error → amber token + "Scan failed"', () => {
        const cfg = badgeConfigFor('error')
        expect(cfg.label).toBe('Scan failed')
        expect(cfg.iconClass).toContain('text-amber-500')
        expect(cfg.spin).toBe(false)
    })

    it('undefined / missing scanStatus defaults to "Not scanned"', () => {
        expect(badgeConfigFor(undefined).label).toBe('Not scanned')
    })

    it('uses only project colour tokens (zinc / brand signal-green / red / amber)', () => {
        // UX4: the success state migrated from raw Tailwind emerald-500 to the
        // brand semantic token signal-green. Other states keep their shades for now.
        const states: ScanStatus[] = ['unscanned', 'scanning', 'clean', 'infected', 'error']
        for (const s of states) {
            const cfg = badgeConfigFor(s)
            expect(cfg.iconClass).toMatch(/text-(zinc-\d{3}|signal-green|red-\d{3}|amber-\d{3})/)
        }
    })
})

describe('tooltipFor', () => {
    it('infected surfaces the clamd signature name when provided', () => {
        expect(tooltipFor('infected', 'Eicar-Test-Signature'))
            .toBe('Detected: Eicar-Test-Signature')
    })

    it('infected without signature falls back to a generic message', () => {
        expect(tooltipFor('infected')).toBe('Malware detected — quarantined')
    })

    it('unscanned tooltip is "Awaiting scan"', () => {
        expect(tooltipFor('unscanned')).toBe('Awaiting scan')
    })

    it('undefined defaults to the unscanned tooltip', () => {
        expect(tooltipFor(undefined)).toBe('Awaiting scan')
    })

    it('returns distinct tooltip copy per state', () => {
        const seen = new Set<string>()
        for (const s of ['unscanned', 'scanning', 'clean', 'infected', 'error'] as const) {
            seen.add(tooltipFor(s))
        }
        expect(seen.size).toBe(5)
    })

    it('error tooltip mentions re-scan availability (matches D6 copy)', () => {
        expect(tooltipFor('error').toLowerCase()).toContain('re-scan')
    })
})
