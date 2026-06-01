// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Task Inject
 *
 * POST /api/v1/tasks/:id/inject
 * Body: { workspaceId: string, message: string }
 *
 * Inserts a task_step row with a high step_number so the executor
 * can drain it at the top of the next iteration.
 * stepType: 'confirmation' (injected user messages)
 * state: 'pending'
 * stepSpec: { role: 'user', content: message }
 */

import { Router } from 'express'
import { db, eq, and, desc } from '@plexo/db'
import { taskSteps, tasks } from '@plexo/db'
import { logger } from '../logger.js'

export const taskInjectRouter = Router()

taskInjectRouter.post('/:id/inject', async (req, res) => {
    const { id } = req.params
    const { workspaceId, message } = req.body as { workspaceId?: string; message?: string }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
        res.status(400).json({ error: { code: 'MISSING_MESSAGE', message: 'message required' } })
        return
    }

    // Verify task exists and belongs to workspace
    const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
        .limit(1)

    if (!task) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
        return
    }

    // Find current max step_number for this task
    const [maxRow] = await db
        .select({ stepNumber: taskSteps.stepNumber })
        .from(taskSteps)
        .where(eq(taskSteps.taskId, id))
        .orderBy(desc(taskSteps.stepNumber))
        .limit(1)

    const nextStepNumber = (maxRow?.stepNumber ?? 0) + 1000

    const [inserted] = await db
        .insert(taskSteps)
        .values({
            taskId: id,
            stepNumber: nextStepNumber,
            state: 'pending',
            stepType: 'confirmation',
            stepSpec: { role: 'user', content: message },
            outcome: message,
        })
        .returning({ stepNumber: taskSteps.stepNumber })

    if (!inserted) {
        res.status(500).json({ error: { code: 'INSERT_FAILED', message: 'Failed to insert step' } })
        return
    }

    logger.info({ taskId: id, stepNumber: inserted.stepNumber }, 'injected user message')

    // Phase H: if message is a verdict signal (✓/✗ or accept/reject), record human_verdict.
    // Non-fatal — outcome capture is gated behind OUTCOME_CAPTURE_ENABLED in outcome-capture.ts.
    const trimmed = message.trim().toLowerCase()
    if (trimmed === '✓' || trimmed === 'accept' || trimmed === 'yes') {
        const { recordHumanVerdict } = await import('../outcome-capture.js')
        void recordHumanVerdict(id, 'accept').catch(() => { /* non-fatal */ })
    } else if (trimmed === '✗' || trimmed === 'reject' || trimmed === 'no') {
        const { recordHumanVerdict } = await import('../outcome-capture.js')
        void recordHumanVerdict(id, 'reject').catch(() => { /* non-fatal */ })
    }

    res.status(202).json({ status: 'queued', stepNumber: inserted.stepNumber })
})
