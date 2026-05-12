// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Promotion Logic — moves shadow models to candidate status.
 *
 * NEVER auto-promotes. Candidate status triggers operator notification.
 * Operator must explicitly confirm via admin API. One-way door.
 */

import { db, sql } from '@plexo/db'
import pino from 'pino'
import { FOUNDRY_DEFAULTS } from './types.js'

const logger = pino({ name: 'foundry:promotion' })

export interface PromotionCandidate {
    modelId: string
    domainBucket: string
    shadowComparisons: number
    shadowAgreementRate: number
}

/**
 * Check for models eligible for promotion.
 * Returns candidates but does NOT promote them.
 */
export async function checkPromotionCandidates(
    minComparisons = FOUNDRY_DEFAULTS.SHADOW_MIN_COMPARISONS,
    threshold = FOUNDRY_DEFAULTS.PROMOTION_THRESHOLD,
): Promise<PromotionCandidate[]> {
    const rows = await db.execute<{
        id: string
        domain_bucket: string
        shadow_comparisons: number
        shadow_agreement_rate: number
    }>(sql`
        SELECT id, domain_bucket, shadow_comparisons, shadow_agreement_rate
        FROM foundry_models
        WHERE status = 'shadow'
        AND shadow_comparisons >= ${minComparisons}
        AND shadow_agreement_rate >= ${threshold}
    `)

    const candidates = rows.map(r => ({
        modelId: r.id,
        domainBucket: r.domain_bucket,
        shadowComparisons: r.shadow_comparisons,
        shadowAgreementRate: r.shadow_agreement_rate,
    }))

    if (candidates.length > 0) {
        // Move to candidate status — awaiting operator confirmation
        for (const c of candidates) {
            await db.execute(sql`
                UPDATE foundry_models SET status = 'candidate' WHERE id = ${c.modelId}
            `)
        }
        logger.info({ count: candidates.length }, 'Models moved to candidate status — awaiting operator confirmation')
    }

    return candidates
}

/**
 * Operator confirms promotion. One-way door.
 */
export async function promoteModel(modelId: string): Promise<void> {
    const [model] = await db.execute<{ status: string; domain_bucket: string }>(sql`
        SELECT status, domain_bucket FROM foundry_models WHERE id = ${modelId}
    `)

    if (!model) throw new Error(`Model ${modelId} not found`)
    if (model.status !== 'candidate') {
        throw new Error(`Model ${modelId} is "${model.status}" — only candidates can be promoted`)
    }

    // Retire any existing promoted model for this bucket
    await db.execute(sql`
        UPDATE foundry_models SET status = 'retired'
        WHERE domain_bucket = ${model.domain_bucket} AND status = 'promoted' AND id != ${modelId}
    `)

    await db.execute(sql`
        UPDATE foundry_models SET status = 'promoted' WHERE id = ${modelId}
    `)

    logger.info({ modelId, bucket: model.domain_bucket }, 'Model promoted — active for routing')
}

/**
 * Operator rejects / retires a model.
 */
export async function retireModel(modelId: string): Promise<void> {
    await db.execute(sql`
        UPDATE foundry_models SET status = 'retired' WHERE id = ${modelId}
    `)
    logger.info({ modelId }, 'Model retired')
}
