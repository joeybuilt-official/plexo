// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shadow Evaluator — runs shadow models against primary outputs.
 *
 * Completely invisible to users. Shadow calls are async, non-blocking.
 * Agreement scores logged for promotion decision.
 */

import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { ulid } from 'ulid'
import { createHash } from 'node:crypto'
import pino from 'pino'
const cosineSimilarity = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0)

const logger = pino({ name: 'foundry:shadow' })

function hashOutput(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * Run a shadow comparison for an inference call.
 * Fire-and-forget — never blocks the primary response.
 *
 * @param modelId - foundry model in shadow status
 * @param inferenceLogId - the primary inference log entry
 * @param primaryOutput - the primary model's output text
 * @param shadowOutput - the shadow model's output text
 * @param embeddingProvider - for computing agreement via cosine similarity
 */
export async function logShadowComparison(
    modelId: string,
    inferenceLogId: string | null,
    primaryOutput: string,
    shadowOutput: string,
    embeddingProvider?: { embed(text: string): Promise<number[]> },
): Promise<void> {
    try {
        let agreementScore: number

        if (embeddingProvider) {
            // Semantic agreement via embedding cosine similarity
            const [primaryVec, shadowVec] = await Promise.all([
                embeddingProvider.embed(primaryOutput.slice(0, 500)),
                embeddingProvider.embed(shadowOutput.slice(0, 500)),
            ])
            agreementScore = cosineSimilarity(primaryVec, shadowVec)
        } else {
            // Fallback: simple token overlap (Jaccard-like)
            const primaryTokens = new Set(primaryOutput.toLowerCase().split(/\s+/))
            const shadowTokens = new Set(shadowOutput.toLowerCase().split(/\s+/))
            const intersection = [...primaryTokens].filter(t => shadowTokens.has(t)).length
            const union = new Set([...primaryTokens, ...shadowTokens]).size
            agreementScore = union > 0 ? intersection / union : 0
        }

        const id = ulid()
        await db.execute(sql`
            INSERT INTO foundry_shadow_results
                (id, model_id, inference_log_id, primary_output_hash, shadow_output_hash, agreement_score)
            VALUES (
                ${id}, ${modelId},
                ${inferenceLogId ? sql`${inferenceLogId}::uuid` : sql`NULL`},
                ${hashOutput(primaryOutput)},
                ${hashOutput(shadowOutput)},
                ${agreementScore}
            )
        `)

        // Update rolling agreement rate on the model
        await db.execute(sql`
            UPDATE foundry_models
            SET shadow_comparisons = shadow_comparisons + 1,
                shadow_agreement_rate = (
                    COALESCE(shadow_agreement_rate, 0) * shadow_comparisons + ${agreementScore}
                ) / (shadow_comparisons + 1)
            WHERE id = ${modelId}
        `)

        logger.debug({ modelId, agreementScore: agreementScore.toFixed(3) }, 'Shadow comparison logged')
    } catch (err) {
        logger.warn({ err, modelId }, 'Shadow comparison failed — non-fatal')
    }
}
