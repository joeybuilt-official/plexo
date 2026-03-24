// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express'
import { db, desc, eq } from '@plexo/db'
import { tasks } from '@plexo/db'
import { freshResponse } from './cache.js'
import { logger } from '../../logger.js'

export const agentsRouter = Router()

agentsRouter.get('/tasks', async (_req, res) => {
    try {
        const rows = await db
            .select({ id: tasks.id, status: tasks.status, title: tasks.title, workspaceId: tasks.workspaceId, createdAt: tasks.createdAt, startedAt: tasks.startedAt, completedAt: tasks.completedAt })
            .from(tasks)
            .orderBy(desc(tasks.createdAt))
            .limit(100)

        res.json(freshResponse(rows.map(t => ({
            id: t.id, status: t.status, description: t.title ?? '', productTarget: null,
            createdAt: t.createdAt, startedAt: t.startedAt, completedAt: t.completedAt, result: null,
        }))))
    } catch (err) {
        logger.error({ err }, 'cmd-center: agent tasks failed')
        res.json(freshResponse([]))
    }
})

agentsRouter.get('/tasks/:id', async (req, res) => {
    try {
        const [row] = await db.select().from(tasks).where(eq(tasks.id, req.params.id)).limit(1)
        if (!row) { res.status(404).json({ error: 'Task not found' }); return }
        res.json(freshResponse({
            id: row.id, status: row.status, description: row.title ?? '', productTarget: null,
            createdAt: row.createdAt, startedAt: row.startedAt, completedAt: row.completedAt, result: null,
        }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: agent task detail failed')
        res.status(500).json({ error: 'Internal error' })
    }
})

agentsRouter.post('/tasks', async (req, res) => {
    try {
        const { description } = req.body
        if (!description) { res.status(400).json({ error: 'description required' }); return }
        const [task] = await db.insert(tasks).values({
            title: description,
            status: 'pending',
            workspaceId: process.env.CMD_CENTER_WORKSPACE_ID ?? '',
        }).returning()
        res.json(freshResponse({
            id: task!.id, status: task!.status, description: task!.title,
            productTarget: null, createdAt: task!.createdAt, startedAt: null, completedAt: null, result: null,
        }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: dispatch task failed')
        res.status(500).json({ error: 'Failed to dispatch task' })
    }
})

agentsRouter.get('/sessions', async (_req, res) => {
    try {
        const { getAgentStatus } = await import('../../agent-loop.js')
        const status = getAgentStatus()
        const sessions = status.activeTaskId ? [{
            id: `session-${Date.now()}`, taskId: status.activeTaskId,
            status: 'active', startedAt: status.lastActivity, lastActivityAt: status.lastActivity,
        }] : []
        res.json(freshResponse(sessions))
    } catch { res.json(freshResponse([])) }
})
