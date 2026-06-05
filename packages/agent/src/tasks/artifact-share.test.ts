// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, afterEach } from 'vitest'
import { autoShareVisibility } from './artifact-share.js'

describe('autoShareVisibility (Phase Q)', () => {
    afterEach(() => { delete process.env.PLEXO_AUTO_SHARE_VISIBILITY })

    it('defaults to unlisted when unset', () => {
        delete process.env.PLEXO_AUTO_SHARE_VISIBILITY
        expect(autoShareVisibility()).toBe('unlisted')
    })

    it('honors off and public', () => {
        process.env.PLEXO_AUTO_SHARE_VISIBILITY = 'off'
        expect(autoShareVisibility()).toBe('off')
        process.env.PLEXO_AUTO_SHARE_VISIBILITY = 'public'
        expect(autoShareVisibility()).toBe('public')
    })

    it('is case-insensitive and falls back to unlisted on unknown values', () => {
        process.env.PLEXO_AUTO_SHARE_VISIBILITY = 'PUBLIC'
        expect(autoShareVisibility()).toBe('public')
        process.env.PLEXO_AUTO_SHARE_VISIBILITY = 'nonsense'
        expect(autoShareVisibility()).toBe('unlisted')
    })
})
