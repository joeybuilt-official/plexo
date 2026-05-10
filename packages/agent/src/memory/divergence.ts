// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Divergence detector — Phase 5 of `graphiti-migration/plan.md`.
 *
 * Sample-based comparison that asks: are facts present in `memory_entries`
 * also retrievable from the workspace's Graphiti store? Run during the
 * `dual` write-mode observation window (≥7 days per ADR 0010 door #1) so
 * the operator can confirm parity before flipping read defaults in Phase 6
 * and the irreversible Phase 9 cutover.
 *
 * Sampling strategy (cheap, doesn't require new sidecar endpoints):
 *
 *   1. Pick the N most-recent `memory_entries` rows for the workspace
 *      that have a non-null subject AND predicate (fact triples we can
 *      build a search query from).
 *   2. For each, query Graphiti via `bridge.search(query=subject, num=10)`
 *      and check whether ANY result's `fact` text contains the predicate.
 *   3. Report the missing-count + the ratio.
 *
 * False positives (postgres row absent from Graphiti when it actually exists):
 *   - Graphiti's hybrid search ranking didn't surface the match in top-10.
 *     Mitigation: increase numResults, or accept that ratio>0 is the
 *     "fuzzy parity" signal. The divergence event captures sampled vs
 *     missing so the dashboards can compute a moving average.
 *
 * Not run automatically by Phase 5 — operator triggers via a route OR
 * pulls into a cron once Phase 6 read-cutover is observed clean.
 */

import pino from 'pino'
import { db, sql } from '@plexo/db'
import { GraphitiClient } from '@plexo/graphiti-bridge'
import { emitMemoryDivergence } from '../analytics/memory-events.js'

const logger = pino({ name: 'memory-divergence' })

export interface DivergenceReport {
    workspaceId: string
    sampled: number
    missingInGraphiti: number
    samplePctMissing: number
    /** Per-row outcomes for debugging — sampled rows + whether Graphiti hit. */
    rows: Array<{ id: string; subject: string; predicate: string; matched: boolean }>
}

export interface DivergenceCheckOpts {
    workspaceId: string
    sampleSize?: number
    /** Inject a custom client for tests. */
    client?: GraphitiClient
    /** Limit graphiti search.num_results — higher = fewer false positives, slower. */
    searchNumResults?: number
}

interface SampleRow extends Record<string, unknown> {
    id: string
    subject: string
    predicate: string
    object: string
}

export async function runDivergenceCheck(opts: DivergenceCheckOpts): Promise<DivergenceReport> {
    const { workspaceId, sampleSize = 10, searchNumResults = 10 } = opts
    const client = opts.client ?? defaultClient()

    if (!client) {
        logger.warn({ workspaceId }, 'divergence: bridge not configured; skipping')
        const report: DivergenceReport = { workspaceId, sampled: 0, missingInGraphiti: 0, samplePctMissing: 0, rows: [] }
        emitMemoryDivergence({ workspaceId, sampled: 0, missingInGraphiti: 0 })
        return report
    }

    // Most-recent fact-shaped rows. We query `memory_entries` directly via raw SQL b/c
    // the Drizzle helper for this exact filter shape would add no readability.
    const rowList = await db.execute<SampleRow>(sql`
        SELECT id::text AS id, subject, predicate, object
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND subject IS NOT NULL
          AND predicate IS NOT NULL
          AND invalid_at IS NULL
        ORDER BY created_at DESC
        LIMIT ${sampleSize}
    `)
    // postgres-js returns the array directly; node-postgres returns { rows }.
    // Drizzle's RowList<T> ⊆ T[] for postgres-js. Coerce defensively.
    const sample = Array.isArray(rowList) ? (rowList as SampleRow[]) : ((rowList as { rows?: SampleRow[] }).rows ?? [])

    const outcomes: DivergenceReport['rows'] = []
    let missing = 0
    for (const row of sample) {
        const r = await client.search({ workspaceId, query: row.subject, numResults: searchNumResults })
        const hit = !!r?.results?.some((res) => (res.fact ?? '').toLowerCase().includes(row.predicate.toLowerCase()))
        if (!hit) missing++
        outcomes.push({ id: row.id, subject: row.subject, predicate: row.predicate, matched: hit })
    }

    const report: DivergenceReport = {
        workspaceId,
        sampled: sample.length,
        missingInGraphiti: missing,
        samplePctMissing: sample.length === 0 ? 0 : missing / sample.length,
        rows: outcomes,
    }
    emitMemoryDivergence({ workspaceId, sampled: sample.length, missingInGraphiti: missing })
    logger.info({ workspaceId, sampled: sample.length, missing }, 'divergence check complete')
    return report
}

function defaultClient(): GraphitiClient | null {
    const baseUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) return null
    return new GraphitiClient({ baseUrl, serviceKey, appId: process.env.PLEXO_APP_ID ?? 'plexo-api' })
}
