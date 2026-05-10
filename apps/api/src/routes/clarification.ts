// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Clarification API routes — Phase D.
 *
 * Exposes blocked tasks' capability negotiation payloads so the web UI
 * and channel adapters can surface alternatives to the user.
 *
 * POST /api/v1/tasks/:taskId/clarification/respond
 *   Queues the user's chosen alternative as a new task.
 */
import { Router, type Router as ExpressRouter } from 'express'
import { db, eq } from '@plexo/db'
import { tasks } from '@plexo/db'
import { push } from '@plexo/queue'
import type { ClarificationRequest } from '@plexo/agent/types'
import { trackEvent } from '../event-tracker.js'
import { logger } from '../logger.js'

export const clarificationRouter: ExpressRouter = Router({ mergeParams: true })

/** GET /api/v1/tasks/:taskId/clarification — fetch the clarification payload */
clarificationRouter.get('/', async (req, res) => {
    const { taskId } = req.params as { taskId: string }
    if (!taskId || taskId.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_TASK', message: 'Valid taskId required (max 64 chars)' } })
        return
    }
    try {
        const [row] = await db
            .select({ context: tasks.context, status: tasks.status, workspaceId: tasks.workspaceId })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1)

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }

        const ctx = row.context as Record<string, unknown>
        const clarification = ctx._clarification as ClarificationRequest | undefined

        if (!clarification) {
            res.status(404).json({ error: { code: 'NO_CLARIFICATION', message: 'No clarification payload on this task' } })
            return
        }

        res.json({
            taskId,
            status: row.status,
            clarification,
        })
    } catch (err) {
        logger.error({ err, taskId }, 'GET /clarification failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch clarification' } })
    }
})

/** POST /api/v1/tasks/:taskId/clarification/respond — pick an alternative */
clarificationRouter.post('/respond', async (req, res) => {
    const { taskId } = req.params as { taskId: string }
    const { alternativeIndex } = req.body as { alternativeIndex?: number }

    if (!taskId || taskId.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_TASK', message: 'Valid taskId required (max 64 chars)' } })
        return
    }
    if (alternativeIndex !== undefined && (typeof alternativeIndex !== 'number' || !Number.isInteger(alternativeIndex) || alternativeIndex < 0)) {
        res.status(400).json({ error: { code: 'INVALID_INDEX', message: 'alternativeIndex must be a non-negative integer' } })
        return
    }

    try {
        const [row] = await db
            .select({ context: tasks.context, status: tasks.status, workspaceId: tasks.workspaceId, type: tasks.type })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1)

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }

        const ctx = row.context as Record<string, unknown>
        const clarification = ctx._clarification as ClarificationRequest | undefined

        if (!clarification) {
            res.status(400).json({ error: { code: 'NO_CLARIFICATION', message: 'Task does not have a clarification payload' } })
            return
        }

        const idx = alternativeIndex ?? 0
        const chosen = clarification.alternatives[idx]
        if (!chosen) {
            res.status(400).json({ error: { code: 'INDEX_OUT_OF_RANGE', message: `Alternative index ${idx} out of range (0–${clarification.alternatives.length - 1})` } })
            return
        }

        // Queue the chosen alternative as a new task
        const newTaskId = await push({
            workspaceId: row.workspaceId ?? '',
            type: row.type ?? 'content_creation',
            source: 'dashboard',
            priority: 1,
            context: {
                description: chosen.taskDescription,
                parentTaskId: taskId,
                chosenAlternative: chosen.label,
            },
        })

        trackEvent('task.clarification_response', 'info', {
            originalTaskId: taskId,
            newTaskId,
            alternativeIndex: idx,
            chosenLabel: chosen.label,
            workspaceId: row.workspaceId,
        })
        res.json({ newTaskId, chosen })
    } catch (err) {
        logger.error({ err, taskId }, 'POST /clarification/respond failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to submit clarification response' } })
    }
})
