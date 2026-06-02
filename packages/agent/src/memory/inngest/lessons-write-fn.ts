// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * lessons.graphiti.write receiver — Phase 1 of ADR-0010 (Graphiti lessons
 * channel). Writes an approved prompt_revision as a temporal lesson fact.
 *
 * Gate: GRAPHITI_LESSONS_ENABLED=1 to activate. Default OFF.
 *
 * Isolation: one Inngest step per revision; concurrent writes to different
 * workspaces are independent. Same workspace serialized by concurrency key.
 */

import pino from 'pino'
import { inngest } from '@plexo/queue/inngest'
import { mirrorToGraphiti } from '../write-backend.js'

const logger = pino({ name: 'lessons-write-fn' })

const LESSONS_ENABLED = () => process.env.GRAPHITI_LESSONS_ENABLED === '1'

export interface LessonsWriteEventData {
    workspaceId: string
    routineId: string
    revisionId: string
    version: number
    content: string
    rationale: string
    sourceOutcomeIds: string[]
    reviewedBy: string
}

export interface LessonsWriteResult {
    ok: boolean
    skipped?: boolean
    reason?: 'no_facts_extracted' | 'mirror_failed'
    episodeId?: string | null
    extractedFactsCount?: number
}

export async function handleLessonsWrite(data: LessonsWriteEventData): Promise<LessonsWriteResult> {
    if (!LESSONS_ENABLED()) return { ok: true, skipped: true }

    const result = await mirrorToGraphiti({
        workspaceId: data.workspaceId,
        content: data.content,
        sourceDescription: `lesson v${data.version} routine:${data.routineId}`,
        name: `lesson:${data.revisionId}`,
        metadata: {
            tag: 'lesson',
            routineId: data.routineId,
            revisionId: data.revisionId,
            version: data.version,
            sourceOutcomeIds: data.sourceOutcomeIds,
            reviewedBy: data.reviewedBy,
        },
    })

    if (!result.ok) {
        logger.warn({ workspaceId: data.workspaceId, revisionId: data.revisionId }, 'lessons-write: mirror failed; not persisting episode id')
        return { ok: false, reason: 'mirror_failed', episodeId: result.episodeId, extractedFactsCount: 0 }
    }

    // facts=0 guard — phase-0 smoke finding: the sidecar can return ok=true
    // with extractedFactsCount=0 when the lesson body has no SPO structure
    // (self-edge dropped, target entity missing). A no-op write must NOT
    // look successful — log it and skip the episode_id write-back so the
    // recall-cap pipeline can't pick up a phantom lesson.
    if ((result.extractedFactsCount ?? 0) === 0) {
        logger.warn(
            { workspaceId: data.workspaceId, revisionId: data.revisionId, episodeId: result.episodeId },
            'lessons-write: extractedFactsCount=0 — lesson body lacks SPO structure; treating as failed write',
        )
        return { ok: false, reason: 'no_facts_extracted', episodeId: result.episodeId, extractedFactsCount: 0 }
    }

    if (result.episodeId) {
        try {
            const { db, eq, promptRevisions } = await import('@plexo/db')
            await db.update(promptRevisions)
                .set({ graphitiEpisodeId: result.episodeId })
                .where(eq(promptRevisions.id, data.revisionId))
        } catch (err) {
            logger.warn(
                { err, revisionId: data.revisionId, episodeId: result.episodeId },
                'lessons-write: failed to persist graphiti_episode_id (graphiti write itself succeeded)',
            )
        }
    }

    return { ok: true, episodeId: result.episodeId, extractedFactsCount: result.extractedFactsCount }
}

export const lessonsWriteFn = inngest.createFunction(
    {
        id: 'lessons-graphiti-write',
        concurrency: { key: 'event.data.workspaceId', limit: 1 },
        retries: 2,
    },
    { event: 'lessons.graphiti.write' },
    async ({ event, step }) => step.run('write-lesson', () => handleLessonsWrite(event.data)),
)
