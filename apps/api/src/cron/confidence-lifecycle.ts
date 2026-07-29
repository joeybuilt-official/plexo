// SPDX-License-Identifier: MIT
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
 */

import pino from 'pino'
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { emitMemoryRetrievalFlush, emitMemoryConfidenceDecay } from '@plexo/agent/analytics/memory-events'

const logger = pino({ name: 'confidence-lifecycle' })

const CONFIDENCE_DECAY_FACTOR = 0.9
const CONFIDENCE_FLOOR = 0.1
const HOT_COOLDOWN_DAYS = 7
const COLD_DEMOTION_DAYS = 90

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
}
