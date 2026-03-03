import { Router, type Router as RouterType } from 'express'
import { db, desc, eq, and } from '@plexo/db'
import { sprints, tasks } from '@plexo/db'
import { logger } from '../logger.js'
import { ulid } from 'ulid'

export const sprintsRouter: RouterType = Router()

// ── GET /api/sprints?workspaceId=&status= ───────────────────────────────────

sprintsRouter.get('/', async (req, res) => {
    const { workspaceId, status, limit = '25' } = req.query as Record<string, string>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }

    try {
        const conditions: ReturnType<typeof eq>[] = [eq(sprints.workspaceId, workspaceId)]
        if (status) {
            conditions.push(eq(sprints.status, status as typeof sprints.$inferSelect.status))
        }

        const items = await db.select().from(sprints)
            .where(and(...conditions))
            .orderBy(desc(sprints.createdAt))
            .limit(Math.min(parseInt(limit, 10) || 25, 100))

        res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/sprints failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch sprints' } })
    }
})

// ── POST /api/sprints ────────────────────────────────────────────────────────

sprintsRouter.post('/', async (req, res) => {
    const { workspaceId, repo, request } = req.body as {
        workspaceId: string
        repo: string
        request: string
    }

    if (!workspaceId || !repo || !request) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId, repo, request required' } })
        return
    }

    try {
        const id = ulid()
        const [sprint] = await db.insert(sprints).values({
            id,
            workspaceId,
            repo,
            request,
            status: 'planning',
        }).returning()

        res.status(201).json(sprint)
    } catch (err) {
        logger.error({ err }, 'POST /api/sprints failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create sprint' } })
    }
})

// ── GET /api/sprints/:id ─────────────────────────────────────────────────────

sprintsRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    try {
        const [sprint] = await db.select().from(sprints).where(eq(sprints.id, id)).limit(1)
        if (!sprint) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
            return
        }
        // Tasks linked to sprint via project field
        const sprintTasks = await db.select().from(tasks)
            .where(eq(tasks.project, id))
            .orderBy(desc(tasks.createdAt))
        res.json({ sprint, tasks: sprintTasks })
    } catch (err) {
        logger.error({ err }, 'GET /api/sprints/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch sprint' } })
    }
})

// ── PATCH /api/sprints/:id ───────────────────────────────────────────────────

sprintsRouter.patch('/:id', async (req, res) => {
    const { id } = req.params
    const { status } = req.body as { status?: string }

    try {
        const updates: Partial<typeof sprints.$inferInsert> = {}
        if (status) updates.status = status as typeof sprints.$inferInsert.status
        if (status === 'complete') updates.completedAt = new Date()

        const [updated] = await db.update(sprints)
            .set(updates)
            .where(eq(sprints.id, id))
            .returning()

        if (!updated) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
            return
        }
        res.json(updated)
    } catch (err) {
        logger.error({ err }, 'PATCH /api/sprints/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update sprint' } })
    }
})
