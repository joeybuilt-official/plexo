// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 — Plexo action registry.
//
// Each entry describes a natural-language phrase that should render as
// an action button (not a link). The matching text is replaced at
// render time with an `<ActionPill>` that dispatches a `WorkAction`.
//
// Pure-logic module; no JSX.

import type { WorkAction } from '@web/components/works/types'

export interface PlexoActionEntry {
    pattern: RegExp
    /** Human-readable label for the button. */
    label: (match: RegExpMatchArray) => string
    /** The action to emit when the button is clicked. */
    action: (match: RegExpMatchArray) => WorkAction
}

function titleCase(word: string): string {
    if (!word) return word
    return word[0]!.toUpperCase() + word.slice(1).toLowerCase()
}

export const PLEXO_ACTIONS: PlexoActionEntry[] = [
    {
        // "Install the Notion connection" / "install a notion connection"
        pattern: /install(?:\s+the|\s+a|\s+an)?\s+([a-z][a-z0-9_-]{1,32})\s+connection/i,
        label: (m) => `Install ${titleCase(m[1]!)} connection`,
        action: (m) => ({ type: 'install', kind: 'connection', id: m[1]!.toLowerCase() }),
    },
    {
        // "Add the Notion connection"
        pattern: /add(?:\s+the|\s+a|\s+an)?\s+([a-z][a-z0-9_-]{1,32})\s+connection/i,
        label: (m) => `Add ${titleCase(m[1]!)} connection`,
        action: (m) => ({ type: 'install', kind: 'connection', id: m[1]!.toLowerCase() }),
    },
    {
        // "Enable the deep-research tool" / "install the X tool"
        pattern: /(?:enable|install|add)(?:\s+the|\s+a|\s+an)?\s+([a-z][a-z0-9_-]{1,32})\s+tool/i,
        label: (m) => `Install ${titleCase(m[1]!)} tool`,
        action: (m) => ({ type: 'install', kind: 'tool', id: m[1]!.toLowerCase() }),
    },
]

/**
 * Find the first action entry whose pattern matches the text.
 * Returns both the entry and the RegExp match so callers can slice
 * the text around the match.
 */
export function findPlexoAction(text: string): { entry: PlexoActionEntry, match: RegExpMatchArray } | null {
    for (const entry of PLEXO_ACTIONS) {
        const match = text.match(entry.pattern)
        if (match) return { entry, match }
    }
    return null
}
