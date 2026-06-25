// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * lessons.graphiti.invalidate receiver — Phase 3 of ADR-0010.
 * Physically deletes all RELATES_TO edges belonging to the rejected lesson
 * episode. Physical deletion is required because the graphiti sidecar's
 * /v1/search does not filter by invalid_at (Phase 0 finding).
 *
 * Gate: GRAPHITI_LESSONS_ENABLED=1. Default OFF.
 */

import pino from 'pino'
import { inngest } from '@plexo/queue/inngest'
import { invalidateGraphitiLesson } from '../write-backend.js'

const logger = pino({ name: 'lessons-invalidate-fn' })

const LESSONS_ENABLED = () => process.env.GRAPHITI_LESSONS_ENABLED === '1'

export interface LessonsInvalidateEventData {
    workspaceId: string
    revisionId: string
    reviewedBy: string
}

export async function handleLessonsInvalidate(data: LessonsInvalidateEventData): Promise<{ ok: boolean; deleted?: number; skipped?: boolean }> {
    if (!LESSONS_ENABLED()) return { ok: true, skipped: true }

    const result = await invalidateGraphitiLesson(data.workspaceId, data.revisionId)

    // Audit: stamp graphiti_invalidated_at when an actual delete ran. Skipped
    // means the episode was never found in graphiti (write skipped or never
    // ran) — nothing to invalidate, leave the column null.
    if (result.ok && !result.skipped) {
        try {
            const { db, promptRevisions } = await import('@plexo/db')
            const { eq } = await import('drizzle-orm')
            await db.update(promptRevisions)
                .set({ graphitiInvalidatedAt: new Date() })
                .where(eq(promptRevisions.id, data.revisionId))
        } catch (err) {
            logger.warn(
                { err, revisionId: data.revisionId, deleted: result.deleted },
                'lessons-invalidate: failed to stamp graphiti_invalidated_at (graphiti delete itself succeeded)',
            )
        }
    }

    return result
}

export const lessonsInvalidateFn = inngest.createFunction(
    {
        id: 'lessons-graphiti-invalidate',
        concurrency: { key: 'event.data.workspaceId', limit: 1 },
        retries: 3,
    },
    { event: 'lessons.graphiti.invalidate' },
    async ({ event, step }) => step.run('invalidate-lesson', () => handleLessonsInvalidate(event.data)),
)
