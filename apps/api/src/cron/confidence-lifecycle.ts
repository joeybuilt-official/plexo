// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 7 — Confidence Lifecycle Jobs
 *
 * flush-retrieval-counts (every 5 min):
 *   Cools down hot entries that haven't been retrieved in > 7 days back to
 *   active. Also demotes active entries with no retrieval in > 90 days to cold.
 *   (query.ts writes retrieval_count / last_retrieved_at inline on each
 *   retrieval; this job handles the tier cooling pass.)
 *
 * decay-confidence (weekly, Sunday 03:00 UTC):
 *   Applies multiplicative decay (×0.9) to all non-anchored entries above the
 *   floor. Anchored entries (is_anchored = true) are exempt. This ensures
 *   stale facts lose weight over time unless actively retrieved or re-confirmed.
 *
 * Phase A2 (ADR 0018, 2026-05-13) — FalkorDB dual-write:
 *   After each postgres UPDATE succeeds, the SAME mutation is replayed as
 *   cypher against every workspace's Episodic graph. Postgres remains
 *   authoritative; cypher failures are logged but do not abort the cron.
 *   Per-workspace per-cypher try/catch; counts diverging >5% emit a warning.
 *   Knn / suggest paths are NOT migrated here — they defer to A3 (Episodic
 *   identity coupling reshape).
 */

import pino from 'pino'
import { db, sql } from '@plexo/db'
import { GraphitiClient, type CypherResponse } from '@plexo/graphiti-bridge'
import { emitMemoryRetrievalFlush, emitMemoryConfidenceDecay } from '@plexo/agent/analytics/memory-events'

const logger = pino({ name: 'confidence-lifecycle' })

const CONFIDENCE_DECAY_FACTOR = 0.9
const CONFIDENCE_FLOOR = 0.1
const HOT_COOLDOWN_DAYS = 7
const COLD_DEMOTION_DAYS = 90

/** Warn when postgres + cypher counts diverge by more than this ratio. */
const COUNT_DIVERGENCE_THRESHOLD = 0.05

let _client: GraphitiClient | null = null
function getCypherClient(): GraphitiClient | null {
    if (_client) return _client
    const baseUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) return null
    _client = new GraphitiClient({ baseUrl, serviceKey, appId: 'plexo-api-confidence-lifecycle' })
    return _client
}

/** Test hooks. */
export function setCypherClientForTest(c: GraphitiClient | null): void {
    _client = c
}
export function resetCypherClientForTest(): void {
    _client = null
}

async function listWorkspaceIds(): Promise<string[]> {
    try {
        const rows = await db.execute<{ id: string }>(sql`
            SELECT id FROM workspaces ORDER BY created_at ASC
        `)
        return rows.map((r) => r.id)
    } catch (err) {
        logger.error({ err }, 'confidence-lifecycle: failed to list workspaces')
        return []
    }
}

function divergenceRatio(pg: number, cy: number): number {
    const denom = Math.max(pg, cy, 1)
    return Math.abs(pg - cy) / denom
}

function extractCount(res: CypherResponse | null): number {
    if (!res || res.rows.length === 0) return 0
    const v = res.rows[0]?.[0]
    return typeof v === 'number' ? v : Number(v ?? 0)
}

interface DualWriteSpec {
    op: string
    cypher: string
    params: Record<string, unknown>
    pgCount: number
}

async function fanOutCypher(specs: DualWriteSpec[]): Promise<void> {
    const client = getCypherClient()
    if (!client) {
        logger.warn('confidence-lifecycle: PLEXO_GRAPHITI_SIDECAR_URL / PLEXO_SERVICE_KEY not configured — skipping cypher dual-write')
        return
    }
    const workspaceIds = await listWorkspaceIds()
    if (workspaceIds.length === 0) return

    for (const workspaceId of workspaceIds) {
        for (const spec of specs) {
            try {
                const res = await client.cypher({
                    workspaceId,
                    cypher: spec.cypher,
                    params: spec.params,
                })
                const cyCount = extractCount(res)
                logger.info(
                    { workspaceId, op: spec.op, pgCount: spec.pgCount, cyCount },
                    'confidence-lifecycle: cypher dual-write complete',
                )
                if (divergenceRatio(spec.pgCount, cyCount) > COUNT_DIVERGENCE_THRESHOLD) {
                    logger.warn(
                        { workspaceId, op: spec.op, pgCount: spec.pgCount, cyCount },
                        'confidence-lifecycle: postgres vs cypher count divergence exceeds threshold',
                    )
                }
            } catch (err) {
                logger.warn(
                    { err, workspaceId, op: spec.op },
                    'confidence-lifecycle: cypher dual-write failed (non-fatal; postgres authoritative)',
                )
            }
        }
    }
}

export async function flushRetrievalCounts(): Promise<void> {
    let cooledCount = 0
    let frozenCount = 0
    try {
        // hot → active: not retrieved in HOT_COOLDOWN_DAYS days
        const cooled = await db.execute(sql`
            UPDATE memory_entries
            SET tier = 'active'
            WHERE tier = 'hot'
              AND (
                last_retrieved_at < NOW() - INTERVAL '1 day' * ${HOT_COOLDOWN_DAYS}
                OR (last_retrieved_at IS NULL AND created_at < NOW() - INTERVAL '1 day' * ${HOT_COOLDOWN_DAYS})
              )
        `)
        cooledCount = (cooled as { rowCount?: number }).rowCount ?? 0

        // active → cold: not retrieved in COLD_DEMOTION_DAYS days
        const frozen = await db.execute(sql`
            UPDATE memory_entries
            SET tier = 'cold'
            WHERE tier = 'active'
              AND superseded_by IS NULL
              AND (
                last_retrieved_at < NOW() - INTERVAL '1 day' * ${COLD_DEMOTION_DAYS}
                OR (last_retrieved_at IS NULL AND created_at < NOW() - INTERVAL '1 day' * ${COLD_DEMOTION_DAYS})
              )
        `)
        frozenCount = (frozen as { rowCount?: number }).rowCount ?? 0

        if (cooledCount > 0 || frozenCount > 0) {
            logger.info({ cooledCount, frozenCount }, 'flush-retrieval-counts: tier update complete')
        }
        emitMemoryRetrievalFlush({ cooledCount, frozenCount })
    } catch (err) {
        logger.error({ err }, 'flush-retrieval-counts: failed')
        throw err
    }

    // Phase A2 dual-write — fan out to FalkorDB per workspace. Tier predicates
    // are bulk MATCHes on (tier, last_retrieved_at); no per-node identity needed.
    const hotCutoff = new Date(Date.now() - HOT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const coldCutoff = new Date(Date.now() - COLD_DEMOTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    await fanOutCypher([
        {
            op: 'hot_to_active',
            cypher:
                'MATCH (e:Episodic) ' +
                "WHERE e.tier = 'hot' AND e.last_retrieved_at < $cutoff " +
                "SET e.tier = 'active' " +
                'RETURN count(e) AS n',
            params: { cutoff: hotCutoff },
            pgCount: cooledCount,
        },
        {
            op: 'active_to_cold',
            cypher:
                'MATCH (e:Episodic) ' +
                "WHERE e.tier = 'active' AND e.superseded_by IS NULL AND e.last_retrieved_at < $cutoff " +
                "SET e.tier = 'cold' " +
                'RETURN count(e) AS n',
            params: { cutoff: coldCutoff },
            pgCount: frozenCount,
        },
    ])
}

export async function decayConfidence(): Promise<void> {
    let decayed = 0
    try {
        const result = await db.execute(sql`
            UPDATE memory_entries
            SET confidence = GREATEST(confidence * ${CONFIDENCE_DECAY_FACTOR}, ${CONFIDENCE_FLOOR})
            WHERE is_anchored = false
              AND superseded_by IS NULL
              AND confidence > ${CONFIDENCE_FLOOR}
        `)
        decayed = (result as { rowCount?: number }).rowCount ?? 0
        logger.info({ decayed, factor: CONFIDENCE_DECAY_FACTOR, floor: CONFIDENCE_FLOOR }, 'decay-confidence: complete')
        emitMemoryConfidenceDecay({ decayedCount: decayed, factor: CONFIDENCE_DECAY_FACTOR, floor: CONFIDENCE_FLOOR })

        // Materialize confidence-band distribution into memory_tier_stats so the
        // heatmap endpoint is O(1) per workspace rather than a full table scan.
        await db.execute(sql`
            INSERT INTO memory_tier_stats (workspace_id, tier, confidence_band, count, last_decay_at)
            SELECT
                workspace_id,
                tier,
                CASE
                    WHEN confidence < 0.2 THEN '0-20'
                    WHEN confidence < 0.4 THEN '20-40'
                    WHEN confidence < 0.6 THEN '40-60'
                    WHEN confidence < 0.8 THEN '60-80'
                    ELSE '80-100'
                END AS confidence_band,
                COUNT(*)::int AS count,
                NOW() AS last_decay_at
            FROM memory_entries
            WHERE superseded_by IS NULL
            GROUP BY workspace_id, tier, confidence_band
            ON CONFLICT (workspace_id, tier, confidence_band)
            DO UPDATE SET count = EXCLUDED.count, last_decay_at = EXCLUDED.last_decay_at
        `)
        logger.info('decay-confidence: memory_tier_stats upserted')
    } catch (err) {
        logger.error({ err }, 'decay-confidence: failed')
        throw err
    }

    // Phase A2 dual-write — confidence decay across Episodic nodes per workspace.
    // The cypher uses max(...) (FalkorDB) as the equivalent of GREATEST in SQL.
    await fanOutCypher([
        {
            op: 'confidence_decay',
            cypher:
                'MATCH (e:Episodic) ' +
                'WHERE coalesce(e.is_anchored, false) = false AND e.confidence > $floor ' +
                'SET e.confidence = CASE WHEN e.confidence * $factor < $floor THEN $floor ELSE e.confidence * $factor END ' +
                'RETURN count(e) AS n',
            params: { factor: CONFIDENCE_DECAY_FACTOR, floor: CONFIDENCE_FLOOR },
            pgCount: decayed,
        },
    ])
}
