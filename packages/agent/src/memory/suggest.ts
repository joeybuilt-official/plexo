// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Suggestion generation — Phase α of the Platform Synthesis Engine.
 *
 * Two surfaces:
 *  - `generateThemeSuggestions`  → reads `memory_themes`, gates promotion-ready
 *    clusters into `synthesis_suggestions(kind='theme.page_draft')`.
 *  - `generateLinkSuggestions`   → walks `memory_entries.embedding` pairwise,
 *    upserts `synthesis_suggestions(kind='link.note_to_note')` for any pair
 *    whose cosine ≥ 0.83 that is not already linked. Capped 50/run.
 *
 * Both upsert by `(workspaceId, dedupe_key)` so the routes are idempotent.
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
    const themes = Array.from(await db.execute<RawTheme>(sql`
        SELECT id, label, member_ids, size, growth_14d, coherence, last_member_at
        FROM memory_themes
        WHERE workspace_id = ${workspaceId}::uuid
          AND status = 'pending'
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

/** Cosine of two equal-length number arrays. */
function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0
    const len = a.length
    for (let i = 0; i < len; i++) {
        const x = a[i] ?? 0
        const y = b[i] ?? 0
        dot += x * y
        na += x * x
        nb += y * y
    }
    const d = Math.sqrt(na) * Math.sqrt(nb)
    return d === 0 ? 0 : dot / d
}

function parseVector(raw: unknown): number[] | null {
    if (raw == null) return null
    if (Array.isArray(raw)) return raw as number[]
    if (typeof raw !== 'string') return null
    const t = raw.trim().replace(/^\[/, '').replace(/\]$/, '')
    if (!t) return null
    const parts = t.split(',')
    const out = new Array<number>(parts.length)
    for (let i = 0; i < parts.length; i++) {
        const n = Number(parts[i])
        if (!Number.isFinite(n)) return null
        out[i] = n
    }
    return out
}

/**
 * Walk every embedded memory_entry pair in a workspace; suggest links above
 * the 0.83 cosine floor. Caps at 50 inserts per run; orders by score desc so
 * the top hits land first when capped.
 *
 * Dedup keys are `link.note_to_note:{minId}:{maxId}` (alphabetical), matching
 * the spec's note-link semantics. Pairs already represented in
 * synthesis_suggestions (any status) are skipped — `dismissed` rows hold the
 * cooldown via the workspace-unique constraint.
 */
export async function generateLinkSuggestions(workspaceId: string): Promise<LinkSuggestionResult> {
    type EntryRow = { id: string; content: string; embedding: string | null; metadata: Record<string, unknown> | null; [key: string]: unknown }
    const rows = Array.from(await db.execute<EntryRow>(sql`
        SELECT id, content, embedding::text AS embedding, metadata
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND embedding IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 2000
    `))

    interface Entry { id: string; label: string; vec: number[] }
    const entries: Entry[] = []
    for (const r of rows) {
        const v = parseVector(r.embedding)
        if (!v || v.length === 0) continue
        const label = (r.content || '').replace(/\s+/g, ' ').slice(0, 80)
        entries.push({ id: r.id, label, vec: v })
    }

    interface Candidate {
        aId: string; bId: string
        aLabel: string; bLabel: string
        score: number
        dedupeKey: string
    }
    const candidates: Candidate[] = []
    let inspectedPairs = 0
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            inspectedPairs++
            const sim = cosine(entries[i]!.vec, entries[j]!.vec)
            if (sim < LINK_COSINE_FLOOR) continue
            const a = entries[i]!
            const b = entries[j]!
            const [minId, maxId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
            const [minLabel, maxLabel] = a.id < b.id ? [a.label, b.label] : [b.label, a.label]
            candidates.push({
                aId: minId,
                bId: maxId,
                aLabel: minLabel,
                bLabel: maxLabel,
                score: sim,
                dedupeKey: `link.note_to_note:${minId}:${maxId}`,
            })
        }
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
