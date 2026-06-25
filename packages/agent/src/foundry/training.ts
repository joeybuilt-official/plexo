// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Training Pipeline — submits fine-tuning jobs and tracks status.
 *
 * Provider-agnostic: concrete providers implement TrainingProvider interface.
 * Extracts scrubbed examples from inference_logs, formats for provider,
 * submits job, polls for completion.
 */

import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { ulid } from 'ulid'
import pino from 'pino'
import type { TrainingProvider, TrainingJobConfig } from './types.js'

const logger = pino({ name: 'foundry:training' })

/**
 * Extract scrubbed training examples for a domain bucket.
 */
export async function extractTrainingData(
    domainBucket: string,
    limit = 5000,
): Promise<Array<{ input: string; output: string }>> {
    const rows = await db.execute<{
        scrub_input_pattern: string
        scrub_output_pattern: string
    }>(sql`
        SELECT scrub_input_pattern, scrub_output_pattern
        FROM inference_logs
        WHERE training_consent = TRUE
        AND domain_region = ${domainBucket}
        AND scrub_input_pattern IS NOT NULL
        AND scrub_output_pattern IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ${limit}
    `)

    return rows.map(r => ({
        input: r.scrub_input_pattern,
        output: r.scrub_output_pattern,
    }))
}

/**
 * Submit a training job for a foundry model.
 */
export async function submitTrainingJob(
    modelId: string,
    domainBucket: string,
    baseModel: string,
    provider: TrainingProvider,
): Promise<string> {
    const data = await extractTrainingData(domainBucket)

    if (data.length === 0) {
        throw new Error(`No training data for bucket "${domainBucket}"`)
    }

    const runId = ulid()

    // Create training run record
    await db.execute(sql`
        INSERT INTO foundry_training_runs
            (id, model_id, domain_bucket, example_count, base_model, provider, status)
        VALUES (${runId}, ${modelId}, ${domainBucket}, ${data.length}, ${baseModel}, ${provider.name}, 'pending')
    `)

    try {
        const config: TrainingJobConfig = {
            domainBucket,
            baseModel,
            trainingData: data,
        }

        const jobId = await provider.submitJob(config)

        await db.execute(sql`
            UPDATE foundry_training_runs
            SET status = 'running', provider_job_id = ${jobId}, started_at = NOW()
            WHERE id = ${runId}
        `)

        await db.execute(sql`
            UPDATE foundry_models SET status = 'training' WHERE id = ${modelId}
        `)

        logger.info({ modelId, runId, jobId, examples: data.length }, 'Training job submitted')
        return runId
    } catch (err) {
        await db.execute(sql`
            UPDATE foundry_training_runs
            SET status = 'failed', error = ${(err as Error).message}, completed_at = NOW()
            WHERE id = ${runId}
        `)
        throw err
    }
}

/**
 * Check training job status and update records.
 */
export async function pollTrainingStatus(
    runId: string,
    provider: TrainingProvider,
): Promise<'running' | 'completed' | 'failed'> {
    const [run] = await db.execute<{
        provider_job_id: string
        model_id: string
    }>(sql`
        SELECT provider_job_id, model_id FROM foundry_training_runs WHERE id = ${runId}
    `)

    if (!run?.provider_job_id) return 'failed'

    const status = await provider.checkStatus(run.provider_job_id)

    if (status.status === 'completed') {
        const deployableModelId = await provider.getModelId(run.provider_job_id)

        await db.execute(sql`
            UPDATE foundry_training_runs
            SET status = 'completed', completed_at = NOW()
            WHERE id = ${runId}
        `)

        await db.execute(sql`
            UPDATE foundry_models
            SET status = 'shadow', provider_model_id = ${deployableModelId},
                provider = ${provider.name}, trained_at = NOW()
            WHERE id = ${run.model_id}
        `)

        logger.info({ runId, modelId: run.model_id, deployableModelId }, 'Training completed — model entering shadow mode')
        return 'completed'
    }

    if (status.status === 'failed') {
        await db.execute(sql`
            UPDATE foundry_training_runs
            SET status = 'failed', error = ${status.error ?? 'Unknown error'}, completed_at = NOW()
            WHERE id = ${runId}
        `)
        await db.execute(sql`
            UPDATE foundry_models SET status = 'failed' WHERE id = ${run.model_id}
        `)
        return 'failed'
    }

    return 'running'
}
