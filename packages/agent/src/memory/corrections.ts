// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * User Correction Feedback Loop
 *
 * Captures user corrections as high-signal learning events. When a user
 * says "that's wrong", edits agent output, or explicitly overrides an
 * instruction, this module:
 *
 * 1. Stores the correction as a pattern memory (searchable via memory API)
 * 2. Decrements confidence on the approach/tool that was corrected
 * 3. Extracts a behavioral rule from the correction (if substantive)
 * 4. Publishes a correction event so RSI and other systems can react
 */

import pino from 'pino'
import { db, sql } from '@plexo/db'
import { learnPreference } from './preferences.js'
import { recordTaskMemory } from './store.js'
import { eventBus, TOPICS } from '../plugins/event-bus.js'

const logger = pino({ name: 'corrections' })

export type CorrectionType = 'explicit_rejection' | 'output_edit' | 'instruction_override'

export interface CorrectionRecord {
    workspaceId: string
    taskId?: string
    originalOutput: string
    correctedOutput?: string
    correctionType: CorrectionType
    userMessage?: string
    toolsInvolved?: string[]
}

// Re-export from principles (which has no DB dependency and is test-safe)
export { hasCorrectionIntent } from '../principles.js'

/**
 * Record a user correction as a learning signal.
 *
 * This is the primary entry point — called from channel handlers
 * when a correction is detected in conversation.
 */
export async function recordCorrection(record: CorrectionRecord): Promise<void> {
    const { workspaceId, taskId, originalOutput, correctedOutput, correctionType, userMessage, toolsInvolved } = record

    try {
        // 1. Store as pattern memory
        const correctionContent = [
            `Correction type: ${correctionType}`,
            userMessage ? `User said: ${userMessage}` : null,
            `Original output: ${originalOutput.slice(0, 500)}`,
            correctedOutput ? `Corrected to: ${correctedOutput.slice(0, 500)}` : null,
            toolsInvolved?.length ? `Tools involved: ${toolsInvolved.join(', ')}` : null,
        ].filter(Boolean).join('\n')

        await recordTaskMemory({
            workspaceId,
            taskId: taskId ?? 'correction-' + Date.now().toString(36),
            description: `User correction: ${userMessage?.slice(0, 100) ?? correctionType}`,
            outcome: 'failure',
            toolsUsed: toolsInvolved ?? [],
            qualityScore: 0.2, // Corrections signal low quality on the original
            notes: correctionContent,
        })

        // 2. Decrement confidence on tools that were corrected
        if (toolsInvolved?.length) {
            for (const tool of toolsInvolved) {
                await learnPreference({
                    workspaceId,
                    key: `tool_correction_${tool}`,
                    value: { corrected: true, lastCorrectionType: correctionType },
                    observationConfidence: 0.15, // Low confidence = slight negative pressure
                })
            }
        }

        // 3. Extract behavioral rule if corrected output is substantive
        if (correctedOutput && correctedOutput.length > 20) {
            const ruleContent = `When asked to ${userMessage?.slice(0, 100) ?? 'perform this type of task'}, the user prefers: ${correctedOutput.slice(0, 300)}`
            try {
                await db.execute(sql`
                    INSERT INTO behavior_rules
                        (id, workspace_id, type, key, label, description, value, source, tags)
                    VALUES
                        (gen_random_uuid(), ${workspaceId}::uuid,
                         'domain_knowledge',
                         ${'correction.' + Date.now().toString(36)},
                         ${'User correction: ' + (userMessage?.slice(0, 50) ?? correctionType)},
                         '',
                         ${JSON.stringify({ type: 'text_block', value: ruleContent })}::jsonb,
                         'correction',
                         ARRAY['auto', 'correction']::text[])
                    ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL
                    DO NOTHING
                `)
            } catch (err) {
                logger.warn({ err, workspaceId }, 'Failed to create behavior rule from correction')
            }
        }

        // 4. Publish event for RSI and other subscribers
        try {
            eventBus.publish(TOPICS.CORRECTION_RECORDED, {
                workspaceId,
                taskId,
                correctionType,
                timestamp: new Date().toISOString(),
            })
        } catch {
            // Event bus not initialized — non-fatal
        }

        logger.info({ workspaceId, taskId, correctionType }, 'User correction recorded')
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to record user correction')
    }
}
