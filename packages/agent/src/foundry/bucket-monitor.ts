// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Bucket Monitor — watches domain buckets for training eligibility.
 *
 * Runs as a background job (cron). Queries inference_logs for
 * consent-approved data, checks thresholds, emits eligibility events.
 */

import { db, sql } from '@plexo/db'
import { ulid } from 'ulid'
import pino from 'pino'
import type { BucketStats } from './types.js'
import { FOUNDRY_DEFAULTS } from './types.js'

const logger = pino({ name: 'foundry:bucket-monitor' })

/**
 * Get domain bucket statistics from inference_logs.
 */
export async function getBucketStats(): Promise<BucketStats[]> {
    const rows = await db.execute<{
        domain_bucket: string
        example_count: number
    }>(sql`
        SELECT domain_region AS domain_bucket, COUNT(*) AS example_count
        FROM inference_logs
        WHERE training_consent = TRUE
        AND scrub_input_pattern IS NOT NULL
        AND domain_region IS NOT NULL
        GROUP BY domain_region
        ORDER BY example_count DESC
    `)

    // Check for existing models
    const models = await db.execute<{
        domain_bucket: string
        status: string
        training_examples: number
    }>(sql`
        SELECT domain_bucket, status, training_examples
        FROM foundry_models
        WHERE status NOT IN ('retired', 'failed')
    `)

    const modelMap = new Map(models.map(m => [m.domain_bucket, m]))

    return rows.map(r => {
        const model = modelMap.get(r.domain_bucket)
        return {
            domainBucket: r.domain_bucket,
            exampleCount: Number(r.example_count),
            hasModel: !!model,
            modelStatus: model?.status,
            lastTrainedExamples: model?.training_examples,
        }
    })
}

export interface EligibilityResult {
    newTraining: BucketStats[]
    retraining: BucketStats[]
}

/**
 * Check which buckets are eligible for training or retraining.
 */
export async function checkEligibility(
    minThreshold = FOUNDRY_DEFAULTS.MIN_TRAINING_THRESHOLD,
    retrainIncrement = FOUNDRY_DEFAULTS.RETRAIN_INCREMENT,
): Promise<EligibilityResult> {
    const stats = await getBucketStats()

    const newTraining: BucketStats[] = []
    const retraining: BucketStats[] = []

    for (const bucket of stats) {
        if (bucket.exampleCount < minThreshold) continue

        if (!bucket.hasModel) {
            newTraining.push(bucket)
        } else if (
            bucket.modelStatus === 'promoted' &&
            bucket.lastTrainedExamples &&
            bucket.exampleCount - bucket.lastTrainedExamples >= retrainIncrement
        ) {
            retraining.push(bucket)
        }
    }

    logger.info({
        totalBuckets: stats.length,
        eligible: newTraining.length,
        retrainable: retraining.length,
    }, 'Bucket eligibility check complete')

    return { newTraining, retraining }
}

/**
 * Create a foundry_models record for a new training candidate.
 */
export async function createFoundryModel(
    domainBucket: string,
    baseModel: string,
    exampleCount: number,
    workspaceId?: string,
): Promise<string> {
    const id = ulid()
    await db.execute(sql`
        INSERT INTO foundry_models (id, workspace_id, domain_bucket, base_model, training_examples, status)
        VALUES (${id}, ${workspaceId ? sql`${workspaceId}::uuid` : sql`NULL`}, ${domainBucket}, ${baseModel}, ${exampleCount}, 'pending')
    `)
    return id
}
