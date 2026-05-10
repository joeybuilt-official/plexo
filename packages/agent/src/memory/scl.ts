// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3 N.3 — `is_scl` promotion gate.
 *
 * Per the Phase 3 spec, a level-1 theme is promoted to SCL (Shared Context
 * Layer) when ALL THREE of these gates pass:
 *
 *   1. Stability      — present in ≥3 consecutive runs with member-Jaccard ≥ 0.6
 *   2. User-touch     — ≥1 accepted suggestion sourced from this theme,
 *                       OR ≥1 manual link added between two of its members
 *   3. Cross-surface  — members from ≥2 distinct apps (metadata.app),
 *                       OR ≥2 distinct kinds (memory_entries.type)
 *
 * If all three pass → memory_themes.is_scl = true AND is_scl_evidence is
 * stored as JSON capturing the evidence used for each gate (idempotent —
 * re-running the evaluator on the same data either keeps `true` or, if a
 * gate has since regressed, demotes it back to `false`).
 *
 * Stability data is sourced from `memory_theme_history` — a snapshot table
 * populated by the cluster route after every run. The snapshot keeps run_id,
 * stable_id, member_ids; we use it to compute the Jaccard chain.
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'

const logger = pino({ name: 'memory-scl' })

// Gate thresholds (Phase 3 spec)
const STABILITY_RUNS_REQUIRED = 3
const STABILITY_JACCARD_FLOOR = 0.6

export interface SclEvidence {
    stability: {
        runsObserved: number
        jaccards: number[]      // pairwise Jaccards over the most recent runs
        stableIdsCompared: string[]
    }
    userTouch: {
        acceptedSuggestionIds: string[]
        manualLinkPairs: Array<{ a: string; b: string }>
    }
    crossSurface: {
        distinctApps: string[]
        distinctKinds: string[]
    }
    evaluatedAt: string
    promoted: boolean
}

export interface SclEvaluationResult {
    /** Themes whose flag was flipped from false → true this run. */
    newlyPromoted: Array<{ themeId: string; stableId: string; label: string }>
    /** Themes whose flag was flipped from true → false this run. */
    newlyDemoted: Array<{ themeId: string; stableId: string; label: string }>
    /** All level-1 themes evaluated. */
    inspected: number
    /** Wall clock. */
    durationMs: number
}

interface RawTheme {
    id: string
    label: string
    stable_id: string | null
    member_ids: string[]
    is_scl: boolean
    [k: string]: unknown
}

interface HistoryRow {
    run_id: string
    member_ids: string[]
    recorded_at: Date
    [k: string]: unknown
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    const union = a.size + b.size - inter
    return union === 0 ? 0 : inter / union
}

/**
 * Snapshot the post-cluster state into memory_theme_history. Called by the
 * cluster route after the run row is inserted; the SCL evaluator then reads
 * this table.
 */
export async function snapshotThemeHistory(
    workspaceId: string,
    runId: string,
    themes: Array<{ id: string; level: number; stableId: string; memberIds: string[]; size: number; coherence: number }>,
): Promise<number> {
    if (themes.length === 0) return 0
    let inserted = 0
    // Chunk to keep statements small at large workspace counts.
    const CHUNK = 200
    for (let i = 0; i < themes.length; i += CHUNK) {
        const batch = themes.slice(i, i + CHUNK)
        const values = sql.join(
            batch.map(t => sql`(${workspaceId}::uuid, ${runId}::uuid, ${t.stableId}, ${t.id}::uuid, ${t.level}, ${`{${t.memberIds.map(id => `"${id}"`).join(',')}}`}::uuid[], ${t.size}, ${t.coherence}, NOW())`),
            sql`, `,
        )
        await db.execute(sql`
            INSERT INTO memory_theme_history (workspace_id, run_id, stable_id, theme_id, level, member_ids, size, coherence, recorded_at)
            VALUES ${values}
        `)
        inserted += batch.length
    }
    return inserted
}

/**
 * Evaluate SCL promotion for every level-1 theme in a workspace.
 *
 * Idempotent: each call recomputes the gates from scratch. is_scl can flip
 * either direction. Evidence is overwritten on each run so the dashboard
 * always reflects the most recent reasoning.
 */
export async function evaluateSclPromotion(workspaceId: string): Promise<SclEvaluationResult> {
    const t0 = Date.now()

    const themes = Array.from(await db.execute<RawTheme>(sql`
        SELECT id, label, stable_id, member_ids, is_scl
        FROM memory_themes
        WHERE workspace_id = ${workspaceId}::uuid
          AND level = 1
    `))

    const newlyPromoted: SclEvaluationResult['newlyPromoted'] = []
    const newlyDemoted: SclEvaluationResult['newlyDemoted'] = []

    for (const t of themes) {
        try {
            const stableId = t.stable_id ?? t.id
            const memberIds = t.member_ids ?? []
            const memberSet = new Set(memberIds)

            // ── Gate 1: Stability ────────────────────────────────────────
            // Pull the most recent ≥STABILITY_RUNS_REQUIRED snapshots for
            // this stable_id. We need 3 historical entries to form 2
            // pairwise Jaccards plus the current run. Spec phrases it as
            // "present in ≥3 consecutive runs with member-Jaccard ≥0.6"
            // — operationalised as: the most-recent N snapshots all share
            // a Jaccard ≥0.6 with the current member set, AND there are
            // at least N=STABILITY_RUNS_REQUIRED-1 such historical rows
            // (so we've observed the cluster across ≥3 distinct runs
            // including this one).
            const histRows = Array.from(await db.execute<HistoryRow>(sql`
                SELECT run_id, member_ids, recorded_at
                FROM memory_theme_history
                WHERE workspace_id = ${workspaceId}::uuid
                  AND stable_id = ${stableId}
                  AND level = 1
                ORDER BY recorded_at DESC
                LIMIT ${STABILITY_RUNS_REQUIRED}
            `))

            const jaccards: number[] = []
            const stableIdsCompared: string[] = []
            for (const h of histRows) {
                const j = jaccard(memberSet, new Set(h.member_ids ?? []))
                jaccards.push(j)
                stableIdsCompared.push(h.run_id)
            }
            const stabilityPass =
                histRows.length >= STABILITY_RUNS_REQUIRED &&
                jaccards.every(j => j >= STABILITY_JACCARD_FLOOR)

            // ── Gate 2: User-touch ───────────────────────────────────────
            // (a) accepted theme.page_draft suggestion sourced from this theme
            // (b) accepted link.note_to_note suggestion whose endpoints are
            //     both in this theme's member_ids
            // We don't have a separate `manual link` table — accepted
            // link.note_to_note suggestions are the proxy.
            const acceptedThemeRows = Array.from(await db.execute<{ id: string }>(sql`
                SELECT id FROM synthesis_suggestions
                WHERE workspace_id = ${workspaceId}::uuid
                  AND status = 'accepted'
                  AND kind = 'theme.page_draft'
                  AND payload ->> 'themeId' = ${t.id}
            `))

            // Manual-link proxy: any accepted link.note_to_note where both
            // endpoints are members of this theme. Cap to the first 50 to
            // keep payload size bounded.
            let manualLinkPairs: Array<{ a: string; b: string }> = []
            if (memberIds.length > 1) {
                const memberLiteral = `{${memberIds.map(id => `"${id}"`).join(',')}}`
                const linkRows = Array.from(await db.execute<{ a: string; b: string }>(sql`
                    SELECT (payload ->> 'aId') AS a, (payload ->> 'bId') AS b
                    FROM synthesis_suggestions
                    WHERE workspace_id = ${workspaceId}::uuid
                      AND status = 'accepted'
                      AND kind = 'link.note_to_note'
                      AND (payload ->> 'aId')::uuid = ANY(${memberLiteral}::uuid[])
                      AND (payload ->> 'bId')::uuid = ANY(${memberLiteral}::uuid[])
                    LIMIT 50
                `))
                manualLinkPairs = linkRows.map(r => ({ a: r.a, b: r.b }))
            }

            const acceptedSuggestionIds = acceptedThemeRows.map(r => r.id)
            const userTouchPass =
                acceptedSuggestionIds.length >= 1 || manualLinkPairs.length >= 1

            // ── Gate 3: Cross-surface ────────────────────────────────────
            // Distinct metadata.app values OR distinct memory_entries.type
            // values across the theme's members.
            let distinctApps: string[] = []
            let distinctKinds: string[] = []
            if (memberIds.length > 0) {
                const memberLiteral = `{${memberIds.map(id => `"${id}"`).join(',')}}`
                const surfaceRows = Array.from(await db.execute<{ app: string | null; kind: string | null }>(sql`
                    SELECT
                      DISTINCT
                      COALESCE(metadata ->> 'app', metadata ->> 'sourceApp', metadata ->> 'source')          AS app,
                      type::text                                                                           AS kind
                    FROM memory_entries
                    WHERE workspace_id = ${workspaceId}::uuid
                      AND id = ANY(${memberLiteral}::uuid[])
                `))
                const appSet = new Set<string>()
                const kindSet = new Set<string>()
                for (const r of surfaceRows) {
                    if (r.app && r.app.trim()) appSet.add(r.app.trim())
                    if (r.kind && r.kind.trim()) kindSet.add(r.kind.trim())
                }
                distinctApps = Array.from(appSet).sort()
                distinctKinds = Array.from(kindSet).sort()
            }
            const crossSurfacePass = distinctApps.length >= 2 || distinctKinds.length >= 2

            // ── Verdict ──────────────────────────────────────────────────
            const promoted = stabilityPass && userTouchPass && crossSurfacePass
            const evidence: SclEvidence = {
                stability: {
                    runsObserved: histRows.length,
                    jaccards: jaccards.map(j => Number(j.toFixed(4))),
                    stableIdsCompared,
                },
                userTouch: {
                    acceptedSuggestionIds,
                    manualLinkPairs,
                },
                crossSurface: {
                    distinctApps,
                    distinctKinds,
                },
                evaluatedAt: new Date().toISOString(),
                promoted,
            }

            // Always update is_scl_evidence so the dashboard sees fresh
            // reasoning. Only flip is_scl when the verdict differs from
            // current — saves a row touch on the no-change path.
            const wasScl = !!t.is_scl
            await db.execute(sql`
                UPDATE memory_themes
                SET is_scl_evidence = ${JSON.stringify(evidence)}::jsonb,
                    is_scl = ${promoted}
                WHERE id = ${t.id}::uuid
                  AND workspace_id = ${workspaceId}::uuid
            `)
            if (promoted && !wasScl) {
                newlyPromoted.push({ themeId: t.id, stableId, label: t.label })
            } else if (!promoted && wasScl) {
                newlyDemoted.push({ themeId: t.id, stableId, label: t.label })
            }
        } catch (err) {
            logger.warn({ err, themeId: t.id, workspaceId }, 'evaluateSclPromotion: theme failed (skipped)')
        }
    }

    const durationMs = Date.now() - t0
    logger.info(
        { workspaceId, inspected: themes.length, promoted: newlyPromoted.length, demoted: newlyDemoted.length, durationMs },
        'evaluateSclPromotion complete',
    )

    return {
        newlyPromoted,
        newlyDemoted,
        inspected: themes.length,
        durationMs,
    }
}
