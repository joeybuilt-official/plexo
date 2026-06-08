// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Synthesis generation tests (Phase 8 v1). Pins the stateless id contract
 * (accept must reconstruct the payload from the id) + suggestion shaping.
 */

import { describe, it, expect } from 'vitest'
import {
    buildSuggestions,
    decodeSuggestionId,
    acceptedSuggestion,
} from '../synthesis.js'
import type { ThemesForest } from '../themes-forest.js'

function forestWith(themeId: string, label: string, memberCount: number): ThemesForest {
    return {
        regions: [{ id: 'region:r', stableId: 'region:r', label, level: 0, size: memberCount, coherence: 0.5, why: null, isScl: false }],
        themes: [{ id: themeId, stableId: themeId, label, level: 1, size: memberCount, coherence: 0.6, why: null, isScl: false, parentId: 'region:r' }],
        subthemes: [],
        members: Array.from({ length: memberCount }, (_, i) => ({
            id: `ep${i}`,
            label: `Note ${i}`,
            kind: 'note',
            themeId,
            regionId: 'region:r',
            url: null,
            score: 1,
        })),
        runId: 'run-1',
        generatedAt: '2026-06-08T00:00:00.000Z',
    }
}

describe('synthesis', () => {
    it('emits a theme.page_draft for a theme with enough members', () => {
        const forest = forestWith('theme:abc', 'Stake Trek 2023', 5)
        const items = buildSuggestions(forest)
        expect(items).toHaveLength(1)
        const s = items[0]!
        expect(s.kind).toBe('theme.page_draft')
        expect(s.payload.label).toBe('Stake Trek 2023')
        expect((s.payload.memberIds as string[]).length).toBe(5)
        expect((s.payload.sampleContents as string[]).length).toBeGreaterThan(0)
        expect(s.status).toBe('pending')
    })

    it('drops themes below the member floor', () => {
        expect(buildSuggestions(forestWith('theme:x', 'Tiny', 2))).toHaveLength(0)
    })

    it('id round-trips label + themeId so accept is stateless', () => {
        const forest = forestWith('theme:abc', 'Family History', 4)
        const id = buildSuggestions(forest)[0]!.id
        const decoded = decodeSuggestionId(id)
        expect(decoded).not.toBeNull()
        expect(decoded!.label).toBe('Family History')
        expect(decoded!.themeId).toBe('theme:abc')
    })

    it('accept reconstructs the payload from id + forest', () => {
        const forest = forestWith('theme:abc', 'Family History', 4)
        const id = buildSuggestions(forest)[0]!.id
        const accepted = acceptedSuggestion(id, forest)
        expect(accepted!.kind).toBe('theme.page_draft')
        expect(accepted!.payload.label).toBe('Family History')
        expect((accepted!.payload.memberIds as string[]).length).toBe(4)
        expect(accepted!.status).toBe('accepted')
    })

    it('rejects a non-synthesis id', () => {
        expect(decodeSuggestionId('not-a-tpd-id')).toBeNull()
    })

    it('respects a kinds filter', () => {
        const forest = forestWith('theme:abc', 'X', 4)
        expect(buildSuggestions(forest, { kinds: ['bookmark.near_duplicate'] })).toHaveLength(0)
        expect(buildSuggestions(forest, { kinds: ['theme.page_draft'] })).toHaveLength(1)
    })
})
