// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, desc, eq, and, sql } from '@plexo/db'
import { tasks, taskSteps } from '@plexo/db'
import { push, list } from '@plexo/queue'
import { logger } from '../logger.js'
import { emitToWorkspace } from '../sse-emitter.js'
import { cancelActiveTask } from '../agent-loop.js'

export const tasksRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const VALID_TASK_TYPES = new Set(['coding', 'deployment', 'research', 'ops', 'opportunity', 'monitoring', 'report', 'online', 'automation'])
const VALID_TASK_SOURCES = new Set(['telegram', 'slack', 'discord', 'scanner', 'github', 'cron', 'dashboard', 'api', 'extension', 'sentry'])

// ── GET /api/tasks?workspaceId=&status=&type=&limit=&cursor= ─────────────────

tasksRouter.get('/', async (req, res) => {
    const {
        workspaceId,
        status,
        type,
        projectId,
        limit = '25',
        cursor,
    } = req.query as Record<string, string>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.json({ items: [], nextCursor: null, total: 0 })
        return
    }
    if (projectId && !UUID_RE.test(projectId)) {
        res.json({ items: [], nextCursor: null, total: 0 })
        return
    }

    try {
        const items = await list({
            workspaceId,
            status: status ?? undefined,
            type: type ?? undefined,
            projectId: projectId ?? undefined,
            limit: Math.min(parseInt(limit, 10) || 25, 100),
            cursor: cursor ?? undefined,
        })

        const nextCursor = items.length === (parseInt(limit, 10) || 25)
            ? items[items.length - 1]?.id ?? null
            : null

        res.json({ items, nextCursor, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/tasks failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch tasks' } })
    }
})

// ── POST /api/tasks ──────────────────────────────────────────────────────────

tasksRouter.post('/', async (req, res) => {
    const { workspaceId, type, source = 'api', context = {}, priority, projectId } = req.body as {
        workspaceId: string
        type: string
        source?: string
        context?: Record<string, unknown>
        priority?: number
        projectId?: string
    }

    if (!workspaceId || !type) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId and type are required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!VALID_TASK_TYPES.has(type)) {
        res.status(400).json({ error: { code: 'INVALID_TYPE', message: `type must be one of: ${[...VALID_TASK_TYPES].join(', ')}` } })
        return
    }
    if (!VALID_TASK_SOURCES.has(source)) {
        res.status(400).json({ error: { code: 'INVALID_SOURCE', message: `source must be one of: ${[...VALID_TASK_SOURCES].join(', ')}` } })
        return
    }
    if (projectId && !UUID_RE.test(projectId)) {
        res.status(400).json({ error: { code: 'INVALID_PROJECT', message: 'Valid UUID required for projectId' } })
        return
    }
    if (priority !== undefined && (typeof priority !== 'number' || priority < 1 || priority > 10)) {
        res.status(400).json({ error: { code: 'INVALID_PRIORITY', message: 'priority must be 1–10' } })
        return
    }

    try {
        const id = await push({
            workspaceId,
            type: type as Parameters<typeof push>[0]['type'],
            source: source as Parameters<typeof push>[0]['source'],
            context,
            priority,
            projectId,
        })
        emitToWorkspace(workspaceId, { type: 'task_queued', taskId: id, source })
        res.status(201).json({ id })
    } catch (err) {
        logger.error({ err }, 'POST /api/tasks failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create task' } })
    }
})

// ── GET /api/tasks/:id ───────────────────────────────────────────────────────

tasksRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        const steps = await db.select().from(taskSteps)
            .where(eq(taskSteps.taskId, id))
            .orderBy(taskSteps.stepNumber)
        res.json({ task, steps })
    } catch (err) {
        logger.error({ err }, 'GET /api/tasks/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch task' } })
    }
})

// ── DELETE /api/tasks/:id ────────────────────────────────────────────────────

tasksRouter.delete('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        // Fetch workspace id before we tombstone the row (for SSE emit)
        const [existing] = await db.select({ workspaceId: tasks.workspaceId, status: tasks.status })
            .from(tasks).where(eq(tasks.id, id)).limit(1)

        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }

        await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, id))

        // Signal the executor immediately if this task is currently running
        const aborted = cancelActiveTask(id)
        logger.info({ taskId: id, aborted }, 'Task cancelled')

        emitToWorkspace(existing.workspaceId, { type: 'task_cancelled', taskId: id })
        res.json({ ok: true, aborted })
    } catch (err) {
        logger.error({ err }, 'DELETE /api/tasks/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to cancel task' } })
    }
})

// ── POST /api/tasks/:id/retry ─────────────────────────────────────────────────
// Re-queues a blocked task with its original context. Cancels the original.

tasksRouter.post('/:id/retry', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        if (task.status !== 'blocked' && task.status !== 'cancelled') {
            res.status(400).json({ error: { code: 'NOT_BLOCKED_OR_FAILED', message: 'Only blocked or failed tasks can be retried' } })
            return
        }

        // Re-queue with same parameters
        const newId = await push({
            workspaceId: task.workspaceId,
            type: task.type as Parameters<typeof push>[0]['type'],
            source: (task.source ?? 'api') as Parameters<typeof push>[0]['source'],
            context: (task.context as Record<string, unknown>) ?? {},
            projectId: task.projectId ?? undefined,
        })

        // Cancel the blocked original
        await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, id))

        logger.info({ originalId: id, newId }, 'Task retried')
        res.status(201).json({ id: newId })
    } catch (err) {
        logger.error({ err }, 'POST /api/tasks/:id/retry failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retry task' } })
    }
})

// ── GET /api/tasks/:id/assets ──────────────────────────────────────────────
// Lists agent-produced assets for a task (files in /tmp/plexo-assets/{taskId}).
// Returns filenames + inline content for text files (≤200KB).

tasksRouter.get('/:id/assets', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        const { readdirSync, statSync, readFileSync } = await import('node:fs')
        const { join, extname } = await import('node:path')

        const dir = `/tmp/plexo-assets/${id}`
        let files: string[]
        try {
            files = readdirSync(dir)
        } catch {
            // No assets directory — task produced no file assets
            res.json({ items: [] })
            return
        }

        const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.csv', '.html', '.xml', '.yaml', '.yml', '.toml', '.sh', '.py', '.ts', '.js', '.sql'])
        const MAX_INLINE = 200 * 1024 // 200KB

        const items = files.map((filename) => {
            const filePath = join(dir, filename)
            const stat = statSync(filePath)
            const ext = extname(filename).toLowerCase()
            const isText = TEXT_EXTS.has(ext)
            let content: string | null = null
            if (isText && stat.size <= MAX_INLINE) {
                try {
                    content = readFileSync(filePath, 'utf8')
                } catch { /* skip */ }
            }
            return {
                filename,
                bytes: stat.size,
                isText,
                content,
                path: filePath,
            }
        })

        res.json({ items })
    } catch (err) {
        logger.error({ err, id }, 'GET /api/tasks/:id/assets failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list assets' } })
    }
})


tasksRouter.get('/stats/summary', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }

    if (!UUID_RE.test(workspaceId)) {
        res.json({ byStatus: {}, cost: { total: 0, thisWeek: 0, ceiling: parseFloat(process.env.API_COST_CEILING_USD ?? '10') } })
        return
    }

    try {
        const rows = await db.execute<{ status: string; count: string }>(sql`
      SELECT status, COUNT(*) as count
      FROM tasks
      WHERE workspace_id = ${workspaceId}
      GROUP BY status
    `)

        const stats: Record<string, number> = {}
        for (const row of rows) {
            stats[row.status] = parseInt(row.count, 10)
        }

        const costCeiling = parseFloat(process.env.API_COST_CEILING_USD ?? '10')
        const [weekCostRow] = await db.execute<{ cost_usd: string | null }>(sql`
            SELECT cost_usd
            FROM api_cost_tracking
            WHERE workspace_id = ${workspaceId}::uuid
              AND week_start = date_trunc('week', NOW())::date
            LIMIT 1
        `)
        const [allTimeCostRow] = await db.execute<{ total: string }>(sql`
            SELECT COALESCE(SUM(cost_usd), 0)::text AS total
            FROM work_ledger
            WHERE workspace_id = ${workspaceId}::uuid
        `)

        res.json({
            byStatus: stats,
            cost: {
                total: parseFloat(allTimeCostRow?.total ?? '0'),
                thisWeek: parseFloat(weekCostRow?.cost_usd ?? '0'),
                ceiling: costCeiling,
            },
        })
    } catch (err) {
        logger.error({ err }, 'GET /api/tasks/stats failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch stats' } })
    }
})
