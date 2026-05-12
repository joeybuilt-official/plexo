// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 4 N.4 — streaming-touch on memory.write.
 *
 * After every successful storeMemory() for type='pattern' the route
 * fires `streamingTouchAfterStore(workspaceId, entryId)` (best-effort,
 * non-blocking). This:
 *
 *   1. kNN-attach via the existing HNSW index — top 15 neighbours
 *      excluding self.
 *   2. Inserts those edges into memory_knn_edges (ON CONFLICT updates
 *      weight + computed_at).
 *   3. Provisionally assigns the new entry to the theme its neighbours
 *      voted for (majority of neighbours that are themselves theme
 *      members, weighted by edge weight). Updates the matched theme's
 *      member_ids + size.
 *   4. Bumps memory_themes.growth_14d on the assigned theme.
 *   5. Re-checks the Phase α promotion gates (size ≥6, span ≥14d,
 *      coherence ≥0.74, growth ≥3) — if newly tripped, emits
 *      `ext.nexalog.theme.crystallized` on the PEX event bus.
 *
 * Constant-time per insert: no full recluster, no UMAP, no LLM call.
 * Worst-case path is ~5ms HNSW + ~2ms theme update at our scale.
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'
import { eventBus } from '../plugins/event-bus.js'

const logger = pino({ name: 'memory-streaming-touch' })

const KNN_K = 15
const COHERENCE_FLOOR = 0.74
const SIZE_FLOOR = 6
const GROWTH_FLOOR = 3
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000

export interface StreamingTouchResult {
    entryId: string
    workspaceId: string
    edgesWritten: number
    matchedThemeId: string | null
    matchedThemeStableId: string | null
    matchedThemeLabel: string | null
    crystallized: boolean
    durationMs: number
}

interface NeighborRow {
    id: string
    weight: number
    theme_id: string | null
    theme_stable_id: string | null
    theme_label: string | null
    [k: string]: unknown
}

interface ThemeStateRow {
    id: string
    label: string
    stable_id: string | null
    member_ids: string[]
    size: number
    growth_14d: number
    coherence: number
    status: string
    crystallized_at: Date | null
    [k: string]: unknown
}

/**
 * Kick off the streaming-touch path. Caller awaits it for the side-effects
 * but should NOT propagate failure to the user — wrap in try/catch (or
 * `void` and forget). Returns the diagnostic struct so logs can summarise.
 */
export async function streamingTouchAfterStore(
    workspaceId: string,
    entryId: string,
): Promise<StreamingTouchResult> {
    const t0 = Date.now()

    // 1) kNN-attach. The HNSW index on memory_entries.embedding lets us
    //    pull top-K in one server-side call. We left-join to memory_themes
    //    via member_ids @> ARRAY[id] so each neighbour carries its theme
    //    membership in the same round-trip.
    const neighbors = Array.from(await db.execute<NeighborRow>(sql`
        WITH src AS (
            SELECT embedding
            FROM memory_entries
            WHERE id = ${entryId}::uuid
              AND workspace_id = ${workspaceId}::uuid
              AND embedding IS NOT NULL
        )
        SELECT
            n.id::text AS id,
            (1 - (s.embedding <=> n.embedding))::real AS weight,
            mt.id::text AS theme_id,
            mt.stable_id AS theme_stable_id,
            mt.label AS theme_label
        FROM src s
        CROSS JOIN LATERAL (
            SELECT t.id, t.embedding
            FROM memory_entries t
            WHERE t.workspace_id = ${workspaceId}::uuid
              AND t.embedding IS NOT NULL
              AND t.id <> ${entryId}::uuid
            ORDER BY t.embedding <=> s.embedding ASC
            LIMIT ${KNN_K}
        ) n
        LEFT JOIN LATERAL (
            SELECT mt2.id, mt2.stable_id, mt2.label
            FROM memory_themes mt2
            WHERE mt2.workspace_id = ${workspaceId}::uuid
              AND mt2.level = 1
              AND mt2.member_ids @> ARRAY[n.id]::uuid[]
            LIMIT 1
        ) mt ON TRUE
        ORDER BY weight DESC
    `))

    if (neighbors.length === 0) {
        // Could legitimately be the very first entry in the workspace, or
        // the entry has no embedding yet. Either way, nothing to do.
        return {
            entryId,
            workspaceId,
            edgesWritten: 0,
            matchedThemeId: null,
            matchedThemeStableId: null,
            matchedThemeLabel: null,
            crystallized: false,
            durationMs: Date.now() - t0,
        }
    }

    // 2) Persist edges in both directions so the (a,b) lookup pattern in
    //    cluster.ts and suggest.ts continues to work the same as full
    //    refreshKnnEdges. Single statement with VALUES list keeps round
    //    trips minimal.
    const edgeValues = sql.join(
        neighbors.flatMap(n => [
            sql`(${workspaceId}::uuid, ${entryId}::uuid, ${n.id}::uuid, ${n.weight}, NOW())`,
            sql`(${workspaceId}::uuid, ${n.id}::uuid, ${entryId}::uuid, ${n.weight}, NOW())`,
        ]),
        sql`, `,
    )
    await db.execute(sql`
        INSERT INTO memory_knn_edges (workspace_id, a_id, b_id, weight, computed_at)
        VALUES ${edgeValues}
        ON CONFLICT (workspace_id, a_id, b_id) DO UPDATE
          SET weight = EXCLUDED.weight,
              computed_at = EXCLUDED.computed_at
    `)
    const edgesWritten = neighbors.length * 2

    // 3) Provisional theme assignment by weighted majority vote. Only
    //    neighbours whose own theme is a level-1 theme contribute. We
    //    sum edge weight per theme, pick the winner.
    const themeVotes = new Map<string, { weight: number; label: string; stableId: string | null }>()
    for (const n of neighbors) {
        if (!n.theme_id) continue
        const cur = themeVotes.get(n.theme_id)
        if (cur) {
            cur.weight += n.weight
        } else {
            themeVotes.set(n.theme_id, {
                weight: n.weight,
                label: n.theme_label ?? '',
                stableId: n.theme_stable_id,
            })
        }
    }

    let matchedThemeId: string | null = null
    let matchedThemeStableId: string | null = null
    let matchedThemeLabel: string | null = null
    let bestWeight = 0
    for (const [tid, v] of themeVotes.entries()) {
        if (v.weight > bestWeight) {
            bestWeight = v.weight
            matchedThemeId = tid
            matchedThemeStableId = v.stableId
            matchedThemeLabel = v.label
        }
    }

    let crystallized = false

    if (matchedThemeId) {
        // 3a/4) Append entry to member_ids (de-duped) + bump size + bump growth_14d.
        // Done in a single UPDATE — array_append + array_distinct via a CTE
        // would be cleaner, but `array_distinct` isn't in core; emulate via
        // SELECT…FROM unnest. The `NOT (member_ids @> …)` guard makes this
        // idempotent if the same entry streams twice (e.g. retry).
        await db.execute(sql`
            UPDATE memory_themes
            SET member_ids = (
                    SELECT ARRAY(SELECT DISTINCT u FROM unnest(array_append(member_ids, ${entryId}::uuid)) AS u)
                ),
                size = (
                    SELECT COUNT(DISTINCT u) FROM unnest(array_append(member_ids, ${entryId}::uuid)) AS u
                ),
                growth_14d = growth_14d + 1,
                last_member_at = NOW(),
                updated_at = NOW()
            WHERE id = ${matchedThemeId}::uuid
              AND workspace_id = ${workspaceId}::uuid
              AND NOT (member_ids @> ARRAY[${entryId}::uuid]::uuid[])
        `)

        // 5) Re-check Phase α gates. We re-read the row for the latest
        //    counts then check span via memory_entries.created_at.
        const stateRows = Array.from(await db.execute<ThemeStateRow>(sql`
            SELECT id, label, stable_id, member_ids, size, growth_14d, coherence, status,
                   (is_scl_evidence ->> 'crystallizedAt')::timestamptz AS crystallized_at
            FROM memory_themes
            WHERE id = ${matchedThemeId}::uuid
              AND workspace_id = ${workspaceId}::uuid
        `))
        const state = stateRows[0]
        if (state) {
            const sizeOk = state.size >= SIZE_FLOOR
            const growthOk = (state.growth_14d ?? 0) >= GROWTH_FLOOR
            const coherenceOk = (state.coherence ?? 0) >= COHERENCE_FLOOR

            // Span check — min/max created_at across members.
            let spanOk = false
            if (state.member_ids?.length) {
                const memberLiteral = `{${state.member_ids.map(id => `"${id}"`).join(',')}}`
                const spanRows = Array.from(await db.execute<{ min_at: Date; max_at: Date }>(sql`
                    SELECT MIN(created_at) AS min_at, MAX(created_at) AS max_at
                    FROM memory_entries
                    WHERE workspace_id = ${workspaceId}::uuid
                      AND id = ANY(${memberLiteral}::uuid[])
                `))
                const span = spanRows[0]
                if (span?.min_at && span?.max_at) {
                    const ms = new Date(span.max_at).getTime() - new Date(span.min_at).getTime()
                    spanOk = ms >= FOURTEEN_DAYS_MS
                }
            }

            const allGatesPass = sizeOk && growthOk && coherenceOk && spanOk
            const alreadyCrystallized = !!state.crystallized_at

            if (allGatesPass && !alreadyCrystallized) {
                crystallized = true

                // Mark crystallized in is_scl_evidence so we don't re-emit
                // every time a new entry pushes the gates above threshold.
                // Use jsonb_set so we don't clobber Phase 3 SCL evidence
                // that may already be there.
                await db.execute(sql`
                    UPDATE memory_themes
                    SET is_scl_evidence = jsonb_set(
                            COALESCE(is_scl_evidence, '{}'::jsonb),
                            '{crystallizedAt}',
                            to_jsonb(NOW()::text),
                            true
                        )
                    WHERE id = ${matchedThemeId}::uuid
                      AND workspace_id = ${workspaceId}::uuid
                `)

                try {
                    eventBus.publish('ext.nexalog.theme.crystallized', {
                        workspaceId,
                        themeId: matchedThemeId,
                        stableId: state.stable_id ?? matchedThemeId,
                        label: state.label,
                        size: state.size,
                        coherence: state.coherence,
                        growth14d: state.growth_14d,
                        triggeringEntryId: entryId,
                    })
                } catch (err) {
                    // Log but don't propagate — the streaming-touch path is
                    // best-effort and never blocks the storeMemory caller.
                    logger.warn({ err, matchedThemeId }, 'streaming-touch: event publish failed')
                }
            }
        }
    }

    const durationMs = Date.now() - t0
    logger.debug(
        {
            workspaceId,
            entryId,
            edgesWritten,
            matchedThemeId,
            matchedThemeLabel,
            crystallized,
            durationMs,
        },
        'streaming-touch complete',
    )

    return {
        entryId,
        workspaceId,
        edgesWritten,
        matchedThemeId,
        matchedThemeStableId,
        matchedThemeLabel,
        crystallized,
        durationMs,
    }
}
