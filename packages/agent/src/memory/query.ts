// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 4 — Canonical Memory Retrieval
 *
 * queryMemory() is the single authoritative entry point for reading
 * memory_entries with Phase 1-aware filtering:
 *  - Skips superseded facts (superseded_by IS NULL)
 *  - Skips invalidated facts (invalid_at IS NULL OR invalid_at > NOW())
 *  - Filters by minimum confidence
 *  - Optionally scopes to a specific user
 *  - Bumps retrieval_count / last_retrieved_at non-blocking
 *
 * Phase 9 (chat.ts injection) and any future callers should use this
 * function rather than writing ad-hoc SQL against memory_entries.
 */

import pino from 'pino'
import { db, sql } from '@plexo/db'
import type { MemoryType, MemoryTier, MemorySearchResult } from './store.js'
import { embed } from './store.js'
import { DEFAULT_NAMESPACE } from './namespace.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { emitMemoryRetrieval } from '../analytics/memory-events.js'

const logger = pino({ name: 'memory:query' })

const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_LIMIT = 5

export interface QueryMemoryParams {
    workspaceId: string
    /** Optional user scope — if provided, results are filtered to rows owned
     *  by this user OR workspace-scoped rows (user_id IS NULL). */
    userId?: string
    queryText: string
    limit?: number
    /** Namespace filter. Defaults to ['default']. */
    namespaces?: string[]
    /** Minimum confidence threshold (0–1). Defaults to 0.5. */
    minConfidence?: number
    /** Forwarded to the embedding call for workspace-aware provider selection. */
    aiSettings?: WorkspaceAISettings
    /** Retrieval strategy. 'vector' (default), 'keyword' (trigram/ILIKE), 'hybrid' (vector + keyword). */
    mode?: 'vector' | 'keyword' | 'hybrid'
}

/**
 * Retrieve memory entries by vector similarity with Phase 1-aware filtering.
 * Returns an empty array if the query cannot be embedded.
 */
export async function queryMemory(params: QueryMemoryParams): Promise<MemorySearchResult[]> {
    const {
        workspaceId,
        userId,
        queryText,
        limit = DEFAULT_LIMIT,
        namespaces = [DEFAULT_NAMESPACE],
        minConfidence = DEFAULT_MIN_CONFIDENCE,
        aiSettings,
        mode = 'vector',
    } = params

    if (!queryText.trim()) return []
    const _retrievalStart = Date.now()

    // Phase 6 read-backend gateway. Default 'postgres' preserves today's
    // behavior; flip to 'graphiti' once Phase 5 dual-write has been observed
    // clean for ≥7 days. Bridge-not-configured silently falls through to
    // postgres so dev workflows w/o the sidecar don't break.
    const { getReadBackend, readFromGraphiti } = await import('./read-backend.js')
    if (getReadBackend() === 'graphiti') {
        const grResults = await readFromGraphiti({ workspaceId, queryText, limit })
        if (grResults !== null) return grResults
    }

    const nsArray = sql`ARRAY[${sql.join(namespaces.map((n) => sql`${n}`), sql`, `)}]::text[]`
    const userClause = userId
        ? sql`AND (user_id = ${userId}::uuid OR user_id IS NULL)`
        : sql``
    const baseFilters = sql`
        WHERE workspace_id = ${workspaceId}::uuid
          AND tier != 'cold'
          AND superseded_by IS NULL
          AND (invalid_at IS NULL OR invalid_at > NOW())
          AND confidence >= ${minConfidence}
          AND namespace = ANY(${nsArray})
          ${userClause}
    `

    type ResultRow = {
        id: string
        workspace_id: string
        type: string
        content: string
        shorthand: string | null
        metadata: Record<string, unknown>
        tier: string
        namespace: string
        created_at: Date
        similarity: number
    }

    let rows: ResultRow[] = []

    if (mode === 'keyword') {
        // Trigram / ILIKE keyword search — no embedding required.
        rows = await db.execute<ResultRow>(sql`
            SELECT id, workspace_id, type, content, shorthand, metadata, tier, namespace, created_at,
                   similarity(content, ${queryText}) AS similarity
            FROM memory_entries
            ${baseFilters}
              AND content ILIKE ${'%' + queryText.split(' ').slice(0, 5).join('%') + '%'}
            ORDER BY
                CASE tier WHEN 'hot' THEN 0 WHEN 'active' THEN 1 ELSE 2 END ASC,
                similarity(content, ${queryText}) DESC
            LIMIT ${limit}
        `)
    } else {
        // vector or hybrid — need an embedding.
        const vector = await embed(queryText, workspaceId, aiSettings).catch((err) => {
            logger.warn({ err, workspaceId }, 'query: embed failed — returning empty results')
            return null
        })
        if (!vector) return []

        const vecStr = `[${vector.join(',')}]`

        if (mode === 'hybrid') {
            rows = await db.execute<ResultRow>(sql`
                WITH vector_hits AS (
                    SELECT id, workspace_id, type, content, shorthand, metadata, tier, namespace, created_at,
                           1 - (embedding <=> ${vecStr}::vector) AS similarity
                    FROM memory_entries
                    ${baseFilters}
                      AND embedding IS NOT NULL
                    ORDER BY embedding <=> ${vecStr}::vector ASC
                    LIMIT ${limit}
                ),
                keyword_hits AS (
                    SELECT id, workspace_id, type, content, shorthand, metadata, tier, namespace, created_at,
                           similarity(content, ${queryText}) AS similarity
                    FROM memory_entries
                    ${baseFilters}
                      AND content ILIKE ${'%' + queryText.split(' ').slice(0, 5).join('%') + '%'}
                    ORDER BY similarity(content, ${queryText}) DESC
                    LIMIT ${limit}
                )
                SELECT DISTINCT ON (id) * FROM (
                    SELECT * FROM vector_hits
                    UNION ALL
                    SELECT * FROM keyword_hits
                ) combined
                ORDER BY id, similarity DESC
                LIMIT ${limit}
            `)
        } else {
            rows = await db.execute<ResultRow>(sql`
                SELECT
                    id, workspace_id, type, content, shorthand, metadata, tier, namespace, created_at,
                    1 - (embedding <=> ${vecStr}::vector) AS similarity
                FROM memory_entries
                ${baseFilters}
                  AND embedding IS NOT NULL
                ORDER BY
                    CASE tier WHEN 'hot' THEN 0 WHEN 'active' THEN 1 ELSE 2 END ASC,
                    embedding <=> ${vecStr}::vector ASC
                LIMIT ${limit}
            `)
        }
    }

    if (rows.length === 0) {
        emitMemoryRetrieval({ workspaceId, userId, mode, resultCount: 0, latencyMs: Date.now() - _retrievalStart })
        return []
    }

    // Bump retrieval counters non-blocking — Phase 7 flush job will batch-commit.
    const ids = rows.map((r) => r.id)
    void db.execute(sql`
        UPDATE memory_entries
        SET retrieval_count = retrieval_count + 1,
            last_retrieved_at = NOW(),
            tier = CASE WHEN tier = 'active' THEN 'hot' ELSE tier END
        WHERE id = ANY(${ids}::uuid[])
    `).catch(() => { /* non-fatal */ })

    emitMemoryRetrieval({ workspaceId, userId, mode, resultCount: rows.length, latencyMs: Date.now() - _retrievalStart })

    return rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        type: r.type as MemoryType,
        content: r.content,
        shorthand: r.shorthand ?? undefined,
        metadata: r.metadata,
        tier: (r.tier ?? 'active') as MemoryTier,
        namespace: r.namespace ?? DEFAULT_NAMESPACE,
        createdAt: r.created_at,
        similarity: r.similarity,
    }))
}
