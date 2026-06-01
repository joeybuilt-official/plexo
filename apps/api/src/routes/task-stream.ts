// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Task Step Stream
 *
 * GET /api/v1/tasks/:id/steps/stream?workspaceId=<id>
 *
 * Server-Sent Events feed of task_steps rows. Polls every 2 s.
 * Stops when task.status reaches a terminal state.
 *
 * Events:
 *   { type: 'step', data: <task_steps row> }
 *   { type: 'done', status: string }
 *   { type: 'error', message: string }
 * Keepalive: ': ping' comment every 15 s
 */

import { Router } from 'express'
import { db, eq, and, gte } from '@plexo/db'
import { taskSteps, tasks } from '@plexo/db'
import { logger } from '../logger.js'

export const taskStreamRouter = Router()

const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled'])

taskStreamRouter.get('/:id/steps/stream', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId query param required' } })
        return
    }

    // Verify task exists and belongs to workspace
    const [task] = await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
        .limit(1)

    if (!task) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
        return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    let lastStep = -1
    let done = false

    async function poll() {
        if (done) return
        try {
            // Fetch new steps since lastStep
            const steps = await db
                .select()
                .from(taskSteps)
                .where(and(eq(taskSteps.taskId, id), gte(taskSteps.stepNumber, lastStep + 1)))
                .orderBy(taskSteps.stepNumber)

            for (const step of steps) {
                if (done) return
                if (step.stepNumber > lastStep) lastStep = step.stepNumber
                res.write(`data: ${JSON.stringify({ type: 'step', data: step })}\n\n`)
            }

            // Check task terminal state
            const [current] = await db
                .select({ status: tasks.status })
                .from(tasks)
                .where(eq(tasks.id, id))
                .limit(1)

            if (current && TERMINAL_STATUSES.has(current.status)) {
                done = true
                res.write(`data: ${JSON.stringify({ type: 'done', status: current.status })}\n\n`)
                res.end()
            }
        } catch (err) {
            logger.error({ err, taskId: id }, 'task-stream poll error')
            if (!done) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: 'Internal poll error' })}\n\n`)
            }
        }
    }

    // Initial poll immediately
    await poll()

    if (done) return

    const pollTimer = setInterval(poll, 2000)
    const pingTimer = setInterval(() => {
        if (!done) res.write(': ping\n\n')
    }, 15000)

    req.on('close', () => {
        done = true
        clearInterval(pollTimer)
        clearInterval(pingTimer)
    })
})
