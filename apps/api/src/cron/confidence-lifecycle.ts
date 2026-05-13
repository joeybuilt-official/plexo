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
 */

import pino from 'pino'
import { db, sql } from '@plexo/db'
import { emitMemoryRetrievalFlush, emitMemoryConfidenceDecay } from '@plexo/agent/analytics/memory-events'

const logger = pino({ name: 'confidence-lifecycle' })

const CONFIDENCE_DECAY_FACTOR = 0.9
const CONFIDENCE_FLOOR = 0.1
const HOT_COOLDOWN_DAYS = 7
const COLD_DEMOTION_DAYS = 90

export async function flushRetrievalCounts(): Promise<void> {
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
        const cooledCount = (cooled as { rowCount?: number }).rowCount ?? 0

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
        const frozenCount = (frozen as { rowCount?: number }).rowCount ?? 0

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
    try {
        const result = await db.execute(sql`
            UPDATE memory_entries
            SET confidence = GREATEST(confidence * ${CONFIDENCE_DECAY_FACTOR}, ${CONFIDENCE_FLOOR})
            WHERE is_anchored = false
              AND superseded_by IS NULL
              AND confidence > ${CONFIDENCE_FLOOR}
        `)
        const decayed = (result as { rowCount?: number }).rowCount ?? 0
        logger.info({ decayed, factor: CONFIDENCE_DECAY_FACTOR, floor: CONFIDENCE_FLOOR }, 'decay-confidence: complete')
        emitMemoryConfidenceDecay({ decayedCount: decayed, factor: CONFIDENCE_DECAY_FACTOR, floor: CONFIDENCE_FLOOR })
    } catch (err) {
        logger.error({ err }, 'decay-confidence: failed')
        throw err
    }
}
