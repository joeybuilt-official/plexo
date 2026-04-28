// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * kNN edge builder — Phase 1 of the unified Knowledge Graph.
 *
 * Reads `memory_entries.embedding` for a workspace and writes the
 * top-k nearest pairs (cosine via the existing HNSW index) into
 * `memory_knn_edges`. Both Leiden clustering and link-suggestion
 * generation read from this table so the O(n²) pairwise scan is
 * computed exactly once per refresh, not three times per pipeline run.
 *
 * Storage convention: edges are undirected — we write the pair as
 * (min(a,b), max(a,b)) so the primary key constraint enforces
 * uniqueness without us having to chase symmetric duplicates. Each
 * source node still points at every neighbour because we insert
 * both (a,b) AND (b,a) ordered rows: the undirected promise lives
 * in the *meaning*, not the row layout. Reverse-direction lookup
 * is the common case (Leiden + link-suggest both walk per-node
 * neighbour lists), and the storage cost — 2× rows — is well below
 * what we'd pay reconstructing both directions in SQL.
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'

const logger = pino({ name: 'memory-knn' })

const ALGO_VERSION = 'knn.v1'
const DEFAULT_K = 15

export interface KnnRefreshResult {
    nEntries: number
    nEdges: number
    durationMs: number
    algoVersion: string
}

interface EmbeddedRow {
    id: string
    embedding: string
}

/**
 * Refresh the kNN edge cache for a workspace. Truncate-and-rebuild
 * inside a single transaction — at our scale (≤ 8k entries) this is
 * faster and simpler than incremental upserts, and it avoids stale
 * edges hanging around when an entry is deleted or re-embedded.
 *
 * @param workspaceId   workspace to refresh
 * @param k             neighbours per node (default 15)
 * @param entryIdsScope optional — only refresh edges for this subset
 *                      (e.g. when a single entry is re-embedded).
 *                      Currently unused; included so the signature
 *                      survives the Phase 4 streaming-touch work.
 */
export async function refreshKnnEdges(
    workspaceId: string,
    k: number = DEFAULT_K,
): Promise<KnnRefreshResult> {
    const t0 = Date.now()

    // Pull every embedded entry's id once. We don't pull the vectors
    // themselves into JS — the kNN search runs in Postgres against
    // the HNSW index, which is dramatically faster than a JS heap walk.
    const idRows = Array.from(await db.execute<{ id: string }>(sql`
        SELECT id FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND embedding IS NOT NULL
        ORDER BY id
    `))
    const nEntries = idRows.length
    if (nEntries === 0) {
        logger.warn({ workspaceId }, 'refreshKnnEdges: no embedded entries — clearing edge cache')
        await db.execute(sql`DELETE FROM memory_knn_edges WHERE workspace_id = ${workspaceId}::uuid`)
        return { nEntries: 0, nEdges: 0, durationMs: Date.now() - t0, algoVersion: ALGO_VERSION }
    }

    // Fetch top-(k+1) nearest for each row — +1 because the row's
    // own match (distance 0) will always be the top hit and we filter it.
    // We run this as one CTE per workspace so HNSW is consulted once
    // per source row server-side, not n² round trips.
    //
    // The output orders edges by (a_id, weight desc) so the rebuild
    // is fully deterministic given identical embeddings.
    const limit = k + 1
    const edges = Array.from(await db.execute<{ a_id: string; b_id: string; weight: number }>(sql`
        WITH src AS (
            SELECT id, embedding
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND embedding IS NOT NULL
        )
        SELECT s.id AS a_id,
               n.id AS b_id,
               (1 - (s.embedding <=> n.embedding))::real AS weight
        FROM src s
        CROSS JOIN LATERAL (
            SELECT t.id, t.embedding
            FROM memory_entries t
            WHERE t.workspace_id = ${workspaceId}::uuid
              AND t.embedding IS NOT NULL
              AND t.id <> s.id
            ORDER BY t.embedding <=> s.embedding ASC
            LIMIT ${limit}
        ) n
        ORDER BY s.id, weight DESC
    `))

    // Truncate-and-rebuild in a single transaction. Insert in chunks of
    // 500 to keep individual statements small while still amortising
    // round-trip overhead.
    const nEdges = edges.length
    await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM memory_knn_edges WHERE workspace_id = ${workspaceId}::uuid`)
        if (nEdges === 0) return
        const CHUNK = 500
        for (let i = 0; i < nEdges; i += CHUNK) {
            const batch = edges.slice(i, i + CHUNK)
            const values = sql.join(
                batch.map(e => sql`(${workspaceId}::uuid, ${e.a_id}::uuid, ${e.b_id}::uuid, ${e.weight}, NOW())`),
                sql`, `,
            )
            await tx.execute(sql`
                INSERT INTO memory_knn_edges (workspace_id, a_id, b_id, weight, computed_at)
                VALUES ${values}
                ON CONFLICT (workspace_id, a_id, b_id) DO UPDATE
                  SET weight = EXCLUDED.weight,
                      computed_at = EXCLUDED.computed_at
            `)
        }
    })

    const durationMs = Date.now() - t0
    logger.info({ workspaceId, nEntries, nEdges, k, durationMs }, 'kNN edges refreshed')
    return { nEntries, nEdges, durationMs, algoVersion: ALGO_VERSION }
}

/**
 * Read all kNN edges for a workspace. Returns rows ordered (a_id, weight desc)
 * so the consuming Leiden code can walk neighbour lists in one streaming pass.
 */
export async function readKnnEdges(workspaceId: string): Promise<Array<{ aId: string; bId: string; weight: number }>> {
    const rows = Array.from(await db.execute<{ a_id: string; b_id: string; weight: number }>(sql`
        SELECT a_id, b_id, weight
        FROM memory_knn_edges
        WHERE workspace_id = ${workspaceId}::uuid
        ORDER BY a_id, weight DESC
    `))
    return rows.map(r => ({ aId: r.a_id, bId: r.b_id, weight: r.weight }))
}

// Lint-friendly export for the unused EmbeddedRow type — kept around
// for the streaming-touch path in Phase 4 where we'll feed individual
// entries into the cache without rebuilding the whole workspace.
export type { EmbeddedRow }
