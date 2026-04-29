// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMarketingEnabled } from '../feature-flags'

const KEYS = ['PLEXO_MARKETING_ENABLED', 'SKIP_LANDING'] as const

describe('isMarketingEnabled', () => {
    let snapshot: Record<string, string | undefined>

    beforeEach(() => {
        snapshot = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
        for (const k of KEYS) delete process.env[k]
    })

    afterEach(() => {
        for (const k of KEYS) {
            const v = snapshot[k]
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    })

    it('defaults to OFF when no flag is set (self-host default)', () => {
        expect(isMarketingEnabled()).toBe(false)
    })

    it('is ON when PLEXO_MARKETING_ENABLED=true (cloud opt-in)', () => {
        process.env.PLEXO_MARKETING_ENABLED = 'true'
        expect(isMarketingEnabled()).toBe(true)
    })

    it('accepts truthy values: 1, true, yes, on', () => {
        for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes']) {
            process.env.PLEXO_MARKETING_ENABLED = v
            expect(isMarketingEnabled()).toBe(true)
        }
    })

    it('treats anything else as off', () => {
        for (const v of ['', '0', 'false', 'no', 'off', 'maybe']) {
            process.env.PLEXO_MARKETING_ENABLED = v
            expect(isMarketingEnabled()).toBe(false)
        }
    })

    it('honors legacy SKIP_LANDING=true as a force-off override', () => {
        process.env.PLEXO_MARKETING_ENABLED = 'true'
        process.env.SKIP_LANDING = 'true'
        expect(isMarketingEnabled()).toBe(false)
    })

    it('SKIP_LANDING=false alone still leaves marketing OFF (default)', () => {
        process.env.SKIP_LANDING = 'false'
        expect(isMarketingEnabled()).toBe(false)
    })
})
