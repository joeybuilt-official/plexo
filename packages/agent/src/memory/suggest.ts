// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Suggestion generation — Phase α of the Platform Synthesis Engine.
 *
 * Two surfaces:
 *  - `generateThemeSuggestions`  → reads `memory_themes`, gates promotion-ready
 *    clusters into `synthesis_suggestions(kind='theme.page_draft')`.
 *  - `generateLinkSuggestions`   → reads precomputed `memory_knn_edges`,
 *    upserts `synthesis_suggestions(kind='link.note_to_note')` for any pair
 *    whose cosine ≥ 0.83 that is not already linked. Capped 50/run.
 *
 * Both upsert by `(workspaceId, dedupe_key)` so the routes are idempotent.
 *
 * Phase 5 note: cross-app suggestion promotion (note→levio.task,
 * asset_cluster→fonto.project, spend_pattern→fylo.budget.signal) lives in
 * `memory/promote.ts` and consumes the suggestions inserted here.
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'

const logger = pino({ name: 'memory-suggest' })

/** Promotion gate per spec §2 of TECH-DESIGN.md. */
const THEME_MIN_SIZE = 6
const THEME_MIN_COHERENCE = 0.74
const THEME_MIN_SPAN_DAYS = 14
const THEME_MIN_GROWTH_14D = 3

/** Link-suggestion floor and per-run cap. */
const LINK_COSINE_FLOOR = 0.83
const LINK_PER_RUN_CAP = 50

export interface ThemeSuggestionResult {
    inserted: number
    skipped: number
    inspected: number
}

export interface LinkSuggestionResult {
    inserted: number
    skipped: number
    inspectedPairs: number
}

type RawTheme = {
    id: string
    label: string
    member_ids: string[]
    size: number
    growth_14d: number
    coherence: number
    last_member_at: Date | null
    [key: string]: unknown
}

/** ms in 14 days. */
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Promote ripe `memory_themes` rows into `synthesis_suggestions`.
 *
 * Gate (all four required):
 *   size ≥ 6, coherence ≥ 0.74, span ≥ 14 days, growth_14d ≥ 3.
 *
 * Score = coherence × ln(size).  Idempotent via dedupe_key=`theme.page_draft:{themeId}`.
 */
export async function generateThemeSuggestions(workspaceId: string): Promise<ThemeSuggestionResult> {
    // Phase 1 — only level=1 themes can be promoted to page drafts. Level 0
    // (regions) are too coarse and level 2 (subthemes) live underneath a theme
    // page already, so promoting them would create duplicate surfaces.
    const themes = Array.from(await db.execute<RawTheme>(sql`
        SELECT id, label, member_ids, size, growth_14d, coherence, last_member_at
        FROM memory_themes
        WHERE workspace_id = ${workspaceId}::uuid
          AND status = 'pending'
          AND level = 1
    `))

    let inserted = 0
    let skipped = 0
    for (const t of themes) {
        if (t.size < THEME_MIN_SIZE) { skipped++; continue }
        if (t.coherence < THEME_MIN_COHERENCE) { skipped++; continue }
        if ((t.growth_14d ?? 0) < THEME_MIN_GROWTH_14D) { skipped++; continue }

        // Span check needs min/max created_at across the members. One row-trip
        // to memory_entries; cheap because member_ids is small (≤ a few hundred).
        const memberIds = (t.member_ids ?? []) as string[]
        if (memberIds.length === 0) { skipped++; continue }

        const spanRows = Array.from(await db.execute<{ min_at: Date; max_at: Date }>(sql`
            SELECT MIN(created_at) AS min_at, MAX(created_at) AS max_at
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND id = ANY(${memberIds}::uuid[])
        `))
        const span = spanRows[0]
        if (!span?.min_at || !span?.max_at) { skipped++; continue }
        const spanMs = new Date(span.max_at).getTime() - new Date(span.min_at).getTime()
        if (spanMs < FOURTEEN_DAYS_MS) { skipped++; continue }

        // Sample contents for the page-draft prompt downstream.
        const sampleRows = Array.from(await db.execute<{ id: string; content: string }>(sql`
            SELECT id, content
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND id = ANY(${memberIds}::uuid[])
            ORDER BY created_at DESC
            LIMIT 8
        `))

        const score = t.coherence * Math.log(Math.max(2, t.size))
        const dedupeKey = `theme.page_draft:${t.id}`
        const payload = {
            themeId: t.id,
            label: t.label,
            memberIds,
            sampleContents: sampleRows.map(r => ({ id: r.id, content: r.content.slice(0, 240) })),
        }

        try {
            await db.execute(sql`
                INSERT INTO synthesis_suggestions
                    (workspace_id, kind, payload, score, source, dedupe_key)
                VALUES
                    (${workspaceId}::uuid, 'theme.page_draft', ${JSON.stringify(payload)}::jsonb,
                     ${score}, 'theme', ${dedupeKey})
                ON CONFLICT (workspace_id, dedupe_key)
                DO UPDATE SET
                    score = EXCLUDED.score,
                    payload = EXCLUDED.payload
                WHERE synthesis_suggestions.status = 'pending'
            `)
            inserted++
        } catch (err) {
            logger.warn({ err, themeId: t.id }, 'theme suggestion upsert failed')
            skipped++
        }
    }

    return { inserted, skipped, inspected: themes.length }
}

/** Extract a useful label line from raw note content. Shared with the
 *  forest endpoint so the same heuristics produce the same `members[].label`. */
const GENERIC_TITLES = new Set(['youtube','twitter','x','instagram','tiktok','facebook','linkedin','reddit','github','medium','substack','telegram','t.me'])
export function deriveMemberLabel(content: string | null | undefined): string {
    const lines = (content || '').split('\n').map(l => l.trim()).filter(Boolean)
    let chosen = lines[0] ?? ''
    if (chosen && GENERIC_TITLES.has(chosen.toLowerCase())) {
        const nonUrl = lines.slice(1).filter(l => !/^https?:\/\//i.test(l))
        const longest = nonUrl.sort((a, b) => b.length - a.length)[0]
        if (longest && longest.length > 8) chosen = longest
    }
    return chosen.replace(/\s+/g, ' ').slice(0, 80)
}

/**
 * Read precomputed kNN pairs above LINK_COSINE_FLOOR from `memory_knn_edges`
 * and turn them into link.note_to_note suggestions. The pairwise scan that
 * lived here in Phase α is gone — clusterMemory refreshes the edge cache so
 * suggest is now a cheap reader.
 *
 * Filters carried over from Phase α:
 *   - skip identical-label pairs (platform-name dupes)
 *   - skip "brandish" labels (single short token, e.g. "Facebook")
 *   - dedupe (a,b) vs (b,a) by minId < maxId
 *   - cap LINK_PER_RUN_CAP per run, ordered by score desc
 *
 * Idempotent via dedupe_key + ON CONFLICT DO UPDATE.
 */
export async function generateLinkSuggestions(workspaceId: string): Promise<LinkSuggestionResult> {
    // 1) Load every pattern entry's id + content for label derivation.
    const entryRows = Array.from(await db.execute<{ id: string; content: string }>(sql`
        SELECT id, content
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND type = 'pattern'
          AND embedding IS NOT NULL
    `))
    const labels = new Map<string, string>()
    for (const r of entryRows) labels.set(r.id, deriveMemberLabel(r.content))

    // 2) Pull edges above the floor. SQL collapses (a,b)/(b,a) into one row
    //    with LEAST/GREATEST so we never see both directions in JS.
    const edgeRows = Array.from(await db.execute<{ a_id: string; b_id: string; weight: number }>(sql`
        SELECT
            LEAST(a_id, b_id)::uuid    AS a_id,
            GREATEST(a_id, b_id)::uuid AS b_id,
            MAX(weight)                AS weight
        FROM memory_knn_edges
        WHERE workspace_id = ${workspaceId}::uuid
          AND weight >= ${LINK_COSINE_FLOOR}
        GROUP BY LEAST(a_id, b_id), GREATEST(a_id, b_id)
    `))

    interface Candidate { aId: string; bId: string; aLabel: string; bLabel: string; score: number; dedupeKey: string }
    const candidates: Candidate[] = []
    const inspectedPairs = edgeRows.length
    for (const row of edgeRows) {
        const aLabel = labels.get(row.a_id) ?? ''
        const bLabel = labels.get(row.b_id) ?? ''
        if (!aLabel || !bLabel) continue
        if (aLabel.trim().toLowerCase() === bLabel.trim().toLowerCase()) continue
        const isBrandish = (l: string) => !/\s/.test(l.trim()) && l.trim().length <= 20
        if (isBrandish(aLabel) || isBrandish(bLabel)) continue
        candidates.push({
            aId: row.a_id,
            bId: row.b_id,
            aLabel,
            bLabel,
            score: Number(row.weight),
            dedupeKey: `link.note_to_note:${row.a_id}:${row.b_id}`,
        })
    }

    candidates.sort((x, y) => y.score - x.score)
    const top = candidates.slice(0, LINK_PER_RUN_CAP)

    let inserted = 0
    let skipped = 0
    for (const c of top) {
        const payload = {
            aId: c.aId,
            bId: c.bId,
            aLabel: c.aLabel,
            bLabel: c.bLabel,
            reason: `cosine=${c.score.toFixed(3)} on memory embeddings`,
        }
        try {
            await db.execute(sql`
                INSERT INTO synthesis_suggestions
                    (workspace_id, kind, payload, score, source, dedupe_key)
                VALUES
                    (${workspaceId}::uuid, 'link.note_to_note', ${JSON.stringify(payload)}::jsonb,
                     ${c.score}, 'edge', ${c.dedupeKey})
                ON CONFLICT (workspace_id, dedupe_key)
                DO UPDATE SET
                    score = EXCLUDED.score,
                    payload = EXCLUDED.payload
                WHERE synthesis_suggestions.status = 'pending'
            `)
            inserted++
        } catch (err) {
            logger.warn({ err, dedupeKey: c.dedupeKey }, 'link suggestion upsert failed')
            skipped++
        }
    }

    return { inserted, skipped, inspectedPairs }
}
