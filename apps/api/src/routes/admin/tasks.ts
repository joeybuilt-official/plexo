// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { eq } from 'drizzle-orm'
import { db, tasks, plexoOpsTaskEvents } from '@plexo/db'
import { requeueForRetry, cancel as queueCancel } from '@plexo/queue'
import { logger } from '../../logger.js'

// Service-key holders can act on any task globally — these endpoints are
// for cluster-level operator triage, not workspace-scoped admin. The
// `manual_requeue` / `manual_cancel` event row records appId for audit.
export const adminTasksRouter: RouterType = Router()

const TERMINAL_STATES = new Set(['complete', 'cancelled'])
const GHOST_THRESHOLD_MS = 3 * 60 * 1000
const MAX_TASK_ID_LENGTH = 64
const MAX_REASON_LENGTH = 1024

async function recordEvent(params: {
    workspaceId: string
    taskId: string
    eventType: string
    fromState: string | null
    toState: string
    metadata?: Record<string, unknown>
}): Promise<void> {
    try {
        await db.insert(plexoOpsTaskEvents).values({
            workspaceId: params.workspaceId,
            taskId: params.taskId,
            eventType: params.eventType,
            fromState: params.fromState,
            toState: params.toState,
            metadata: params.metadata ?? {},
        })
    } catch (err) {
        logger.debug({ err, taskId: params.taskId }, 'failed to record admin task event')
    }
}

function getTaskId(req: Request, res: Response): string | null {
    const id = req.params.id
    if (typeof id !== 'string' || id.length === 0) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'task id required' } })
        return null
    }
    if (id.length > MAX_TASK_ID_LENGTH) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'task id too long' } })
        return null
    }
    return id
}

async function loadTask(id: string): Promise<typeof tasks.$inferSelect | null> {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
    return row ?? null
}

adminTasksRouter.get('/:id', async (req, res) => {
    const id = getTaskId(req, res)
    if (id === null) return

    try {
        const task = await loadTask(id)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'task not found' } })
            return
        }

        const now = Date.now()
        const claimedAtMs = task.claimedAt ? task.claimedAt.getTime() : null
        const isActive = task.status === 'claimed' || task.status === 'running'
        const heartbeat_age_ms = isActive && claimedAtMs !== null ? now - claimedAtMs : null
        const claim_expired = task.claimedUntil ? task.claimedUntil.getTime() < now : false
        const ghost_risk = task.status === 'running' && heartbeat_age_ms !== null && heartbeat_age_ms > GHOST_THRESHOLD_MS

        logger.info(
            { taskId: id, appId: req.serviceContext?.appId, userId: req.serviceContext?.userId, status: task.status },
            'admin.task.get'
        )
        res.json({
            task,
            computed: { heartbeat_age_ms, claim_expired, ghost_risk },
        })
    } catch (err) {
        logger.error({ err, taskId: id }, 'GET /admin/tasks/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'failed to load task' } })
    }
})

adminTasksRouter.post('/:id/requeue', async (req, res) => {
    const id = getTaskId(req, res)
    if (id === null) return

    const body = (req.body ?? {}) as { maxAttempts?: unknown; backoffSeconds?: unknown }
    const opts: { maxAttempts?: number; backoffBase?: number } = {}
    if (body.maxAttempts !== undefined) {
        if (typeof body.maxAttempts !== 'number' || !Number.isFinite(body.maxAttempts) || body.maxAttempts < 1) {
            res.status(400).json({ error: { code: 'INVALID_BODY', message: 'maxAttempts must be a positive number' } })
            return
        }
        opts.maxAttempts = body.maxAttempts
    }
    if (body.backoffSeconds !== undefined) {
        if (typeof body.backoffSeconds !== 'number' || !Number.isFinite(body.backoffSeconds) || body.backoffSeconds < 0) {
            res.status(400).json({ error: { code: 'INVALID_BODY', message: 'backoffSeconds must be a non-negative number' } })
            return
        }
        opts.backoffBase = body.backoffSeconds
    }

    try {
        const task = await loadTask(id)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'task not found' } })
            return
        }
        if (TERMINAL_STATES.has(task.status)) {
            logger.warn(
                {
                    taskId: id,
                    appId: req.serviceContext?.appId,
                    userId: req.serviceContext?.userId,
                    status: task.status,
                },
                'admin.task.invalid_state'
            )
            res.status(409).json({ error: { code: 'INVALID_STATE', message: `task is in terminal state ${task.status}` } })
            return
        }

        const prevStatus = task.status
        const result = await requeueForRetry(id, opts)
        const updated = await loadTask(id)
        const toState = updated?.status ?? (result === 'requeued' ? 'queued' : 'failed')

        void recordEvent({
            workspaceId: task.workspaceId,
            taskId: id,
            eventType: 'manual_requeue',
            fromState: prevStatus,
            toState,
            metadata: {
                appId: req.serviceContext?.appId,
                userId: req.serviceContext?.userId,
                body: { maxAttempts: opts.maxAttempts, backoffSeconds: opts.backoffBase },
                result,
            },
        })

        logger.info(
            {
                taskId: id,
                appId: req.serviceContext?.appId,
                userId: req.serviceContext?.userId,
                prevStatus,
                result,
                newStatus: toState,
            },
            'admin.task.requeue'
        )
        res.json({ ok: true, result, task: updated })
    } catch (err) {
        logger.error({ err, taskId: id }, 'POST /admin/tasks/:id/requeue failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'failed to requeue task' } })
    }
})

adminTasksRouter.post('/:id/cancel', async (req, res) => {
    const id = getTaskId(req, res)
    if (id === null) return

    const rawReason = req.body?.reason
    let reason: string | undefined
    if (rawReason !== undefined && rawReason !== null) {
        if (typeof rawReason !== 'string') {
            res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'reason too long' } })
            return
        }
        if (rawReason.length > MAX_REASON_LENGTH) {
            res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'reason too long' } })
            return
        }
        reason = rawReason
    }

    try {
        const task = await loadTask(id)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'task not found' } })
            return
        }
        if (TERMINAL_STATES.has(task.status)) {
            logger.warn(
                {
                    taskId: id,
                    appId: req.serviceContext?.appId,
                    userId: req.serviceContext?.userId,
                    status: task.status,
                },
                'admin.task.invalid_state'
            )
            res.status(409).json({ error: { code: 'INVALID_STATE', message: `task is in terminal state ${task.status}` } })
            return
        }

        const prevStatus = task.status
        await queueCancel(id)
        const updated = await loadTask(id)

        void recordEvent({
            workspaceId: task.workspaceId,
            taskId: id,
            eventType: 'manual_cancel',
            fromState: prevStatus,
            toState: updated?.status ?? 'cancelled',
            metadata: {
                appId: req.serviceContext?.appId,
                userId: req.serviceContext?.userId,
                reason,
            },
        })

        logger.info(
            {
                taskId: id,
                appId: req.serviceContext?.appId,
                userId: req.serviceContext?.userId,
                prevStatus,
            },
            'admin.task.cancel'
        )
        res.json({ ok: true, task: updated })
    } catch (err) {
        logger.error({ err, taskId: id }, 'POST /admin/tasks/:id/cancel failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'failed to cancel task' } })
    }
})
