import { Router, type Router as RouterType } from 'express'
import { db, eq, desc } from '@plexo/db'
import { workspaces } from '@plexo/db'

export const workspacesRouter: RouterType = Router()

// GET /api/workspaces — list workspaces, optionally filter by ownerId
workspacesRouter.get('/', async (req, res) => {
    const { ownerId } = req.query as Record<string, string>
    try {
        const query = db
            .select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
            .from(workspaces)

        const rows = await (ownerId
            ? query.where(eq(workspaces.ownerId, ownerId)).orderBy(desc(workspaces.createdAt)).limit(10)
            : query.orderBy(desc(workspaces.createdAt)).limit(50)
        )

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list workspaces' } })
    }
})

// GET /api/workspaces/:id
workspacesRouter.get('/:id', async (req, res) => {
    try {
        const [ws] = await db
            .select({ id: workspaces.id, name: workspaces.name, settings: workspaces.settings, createdAt: workspaces.createdAt })
            .from(workspaces)
            .where(eq(workspaces.id, req.params.id))
            .limit(1)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }
        res.json(ws)
    } catch (err) {
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get workspace' } })
    }
})

// PATCH /api/workspaces/:id — update name and/or settings
workspacesRouter.patch('/:id', async (req, res) => {
    const { name, settings } = req.body as { name?: string; settings?: Record<string, unknown> }
    try {
        const update: Record<string, unknown> = {}
        if (name) update.name = name
        if (settings !== undefined) update.settings = settings

        if (Object.keys(update).length === 0) {
            res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'name or settings required' } })
            return
        }

        await db.update(workspaces).set(update).where(eq(workspaces.id, req.params.id))
        res.json({ ok: true })
    } catch (err) {
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update workspace' } })
    }
})
