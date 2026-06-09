// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Persistence for synthesis-inbox actions (Phase 8 v2). Suggestions are
 * computed on demand and not stored; only the user's action (dismiss /
 * snooze / accept) is persisted, keyed by the deterministic suggestion id,
 * so dismissed/snoozed items don't re-surface in the pending inbox after a
 * reload. Table: synthesis_suggestion_state (migration 0132).
 */

import { db, synthesisSuggestionState, and, eq, sql } from '@plexo/db'

export type SynthStatus = 'dismissed' | 'snoozed' | 'accepted'

export interface StateRow {
    suggestionId: string
    kind: string
    status: string
    snoozedUntil: Date | null
}

/** Suggestion ids that should be hidden from the pending inbox:
 *  dismissed, accepted, or currently-snoozed. */
export async function getSuppressedIds(workspaceId: string): Promise<Set<string>> {
    const rows = await db
        .select({
            suggestionId: synthesisSuggestionState.suggestionId,
            status: synthesisSuggestionState.status,
            snoozedUntil: synthesisSuggestionState.snoozedUntil,
        })
        .from(synthesisSuggestionState)
        .where(eq(synthesisSuggestionState.workspaceId, workspaceId))
    const now = Date.now()
    const set = new Set<string>()
    for (const r of rows) {
        if (r.status === 'dismissed' || r.status === 'accepted') set.add(r.suggestionId)
        else if (r.status === 'snoozed' && r.snoozedUntil && r.snoozedUntil.getTime() > now) {
            set.add(r.suggestionId)
        }
    }
    return set
}

/** Rows for a given status tab. For "snoozed", only still-active rows. */
export async function getByStatus(workspaceId: string, status: SynthStatus): Promise<StateRow[]> {
    const rows = await db
        .select({
            suggestionId: synthesisSuggestionState.suggestionId,
            kind: synthesisSuggestionState.kind,
            status: synthesisSuggestionState.status,
            snoozedUntil: synthesisSuggestionState.snoozedUntil,
        })
        .from(synthesisSuggestionState)
        .where(
            and(
                eq(synthesisSuggestionState.workspaceId, workspaceId),
                eq(synthesisSuggestionState.status, status)
            )
        )
    const now = Date.now()
    return rows.filter((r) => status !== 'snoozed' || (r.snoozedUntil ? r.snoozedUntil.getTime() > now : false))
}

/** Upsert the action for a suggestion. */
export async function setState(
    workspaceId: string,
    suggestionId: string,
    kind: string,
    status: SynthStatus,
    snoozedUntil: Date | null = null
): Promise<void> {
    await db
        .insert(synthesisSuggestionState)
        .values({ workspaceId, suggestionId, kind, status, snoozedUntil })
        .onConflictDoUpdate({
            target: [synthesisSuggestionState.workspaceId, synthesisSuggestionState.suggestionId],
            set: { status, snoozedUntil, updatedAt: sql`now()` },
        })
}
