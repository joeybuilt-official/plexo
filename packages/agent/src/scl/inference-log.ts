// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Structural inference logging with SCL metadata.
 *
 * Every LLM call gets logged with structural metadata (Tier 1).
 * When training_consent=true, PII-scrubbed patterns are also stored (Tier 2).
 *
 * Logging is fire-and-forget — never blocks the inference response.
 */

import { db, sql } from '@plexo/db'
import { scrubPII } from './pii-scrub.js'
import { hasTrainingConsent } from './storage.js'
import pino from 'pino'

const logger = pino({ name: 'scl:inference-log' })

export interface InferenceLogEntry {
    workspaceId: string
    instanceUuid?: string
    model: string
    provider?: string
    inputTokens: number
    outputTokens: number
    latencyMs: number
    taskType: string
    success: boolean
    // SCL metadata (Tier 1)
    domainRegion?: string
    regionsActivated?: string[]
    resolutionLevel?: string
    contextBudgetUsed?: number
    // Quality signal
    accepted?: boolean
    // Raw text for Tier 2 scrubbing (never stored raw)
    inputText?: string
    outputText?: string
}

/**
 * Log an inference call with structural metadata.
 * Fire-and-forget — call with void/catch.
 */
export async function logInference(entry: InferenceLogEntry): Promise<void> {
    try {
        const consent = await hasTrainingConsent(entry.workspaceId)

        // Tier 2: PII-scrubbed patterns (only when consent=true)
        let scrubInput: string | null = null
        let scrubOutput: string | null = null
        if (consent && entry.inputText) {
            scrubInput = scrubPII(entry.inputText.slice(0, 2000))
        }
        if (consent && entry.outputText) {
            scrubOutput = scrubPII(entry.outputText.slice(0, 2000))
        }

        await db.execute(sql`
            INSERT INTO inference_logs (
                workspace_id, instance_uuid, model, provider,
                input_tokens, output_tokens, latency_ms,
                domain_region, regions_activated, resolution_level, context_budget_used,
                task_type, success, accepted,
                scrub_input_pattern, scrub_output_pattern, training_consent
            ) VALUES (
                ${entry.workspaceId}::uuid,
                ${entry.instanceUuid ?? null},
                ${entry.model},
                ${entry.provider ?? null},
                ${entry.inputTokens},
                ${entry.outputTokens},
                ${entry.latencyMs},
                ${entry.domainRegion ?? null},
                ${entry.regionsActivated ? sql`${entry.regionsActivated}::text[]` : sql`NULL`},
                ${entry.resolutionLevel ?? null},
                ${entry.contextBudgetUsed ?? null},
                ${entry.taskType},
                ${entry.success},
                ${entry.accepted ?? null},
                ${scrubInput},
                ${scrubOutput},
                ${consent}
            )
        `)
    } catch (err) {
        logger.warn({ err, model: entry.model }, 'Inference log write failed — non-fatal')
    }
}
