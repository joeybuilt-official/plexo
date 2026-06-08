// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Synthesis suggestion generation (Phase 8 v1). Derives suggestions from
 * the themes-forest. Stateless: a suggestion's id encodes everything the
 * accept handler needs (kind + theme label + theme id), so accept can
 * reconstruct the payload by id without a persistence table. Dismiss /
 * snooze / mute are best-effort no-ops for now (the Nexalog client removes
 * cards optimistically and treats mute as localStorage-canonical).
 *
 * v1 emits one kind: `theme.page_draft` — "fuse these N notes into a page"
 * — which maps directly onto a substantial forest theme.
 */

import type { ThemesForest } from './themes-forest.js'

export interface Suggestion {
    id: string
    kind: string
    payload: Record<string, unknown>
    score: number
    surfaced_at: string | null
    status?: string | null
}

const MIN_MEMBERS_FOR_PAGE = 3
const MAX_SAMPLE_CONTENTS = 8

interface DecodedId {
    kind: 'theme.page_draft'
    label: string
    themeId: string
}

function encodeId(label: string, themeId: string): string {
    const json = JSON.stringify({ l: label, t: themeId })
    return 'tpd:' + Buffer.from(json, 'utf8').toString('base64url')
}

export function decodeSuggestionId(id: string): DecodedId | null {
    if (!id.startsWith('tpd:')) return null
    try {
        const json = Buffer.from(id.slice(4), 'base64url').toString('utf8')
        const obj = JSON.parse(json) as { l?: unknown; t?: unknown }
        if (typeof obj.l !== 'string' || typeof obj.t !== 'string') return null
        return { kind: 'theme.page_draft', label: obj.l, themeId: obj.t }
    } catch {
        return null
    }
}

/** Member ids + labels for a theme, capped. */
function themeMembers(forest: ThemesForest, themeId: string) {
    const ids: string[] = []
    const labels: string[] = []
    for (const m of forest.members) {
        if (m.themeId !== themeId) continue
        ids.push(m.id)
        if (labels.length < MAX_SAMPLE_CONTENTS && m.label) labels.push(m.label)
    }
    return { ids, labels }
}

export interface BuildSuggestionsOpts {
    kinds?: string[]
    limit?: number
}

export function buildSuggestions(forest: ThemesForest, opts: BuildSuggestionsOpts = {}): Suggestion[] {
    const { kinds, limit = 15 } = opts
    if (kinds && kinds.length && !kinds.includes('theme.page_draft')) return []

    // Biggest themes first — theme.size (entity count) reflects real
    // prominence; member counts are capped so they don't discriminate.
    const themes = [...forest.themes].sort((a, b) => b.size - a.size)

    const out: Suggestion[] = []
    for (const theme of themes) {
        const { ids, labels } = themeMembers(forest, theme.id)
        if (ids.length < MIN_MEMBERS_FOR_PAGE) continue
        const score = theme.coherence != null ? theme.coherence : Math.min(1, theme.size / 20)
        out.push({
            id: encodeId(theme.label, theme.id),
            kind: 'theme.page_draft',
            payload: {
                label: theme.label,
                memberIds: ids,
                sampleContents: labels,
            },
            score,
            surfaced_at: forest.generatedAt,
            status: 'pending',
        })
        if (out.length >= limit) break
    }
    return out
}

/** Reconstruct an accepted suggestion from its id + the (recomputed) forest.
 *  Falls back to id-encoded label only when the theme has shifted out of the
 *  current forest, so the page title is always present. */
export function acceptedSuggestion(id: string, forest: ThemesForest): Suggestion | null {
    const decoded = decodeSuggestionId(id)
    if (!decoded) return null
    const { ids, labels } = themeMembers(forest, decoded.themeId)
    return {
        id,
        kind: 'theme.page_draft',
        payload: {
            label: decoded.label,
            memberIds: ids,
            sampleContents: labels,
        },
        score: 0,
        surfaced_at: null,
        status: 'accepted',
    }
}
