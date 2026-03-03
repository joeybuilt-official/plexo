/**
 * Cron jobs API
 *
 * GET    /api/cron?workspaceId=    List cron jobs
 * POST   /api/cron                 Create cron job
 * PATCH  /api/cron/:id             Update (schedule, enabled, name)
 * DELETE /api/cron/:id             Delete
 * POST   /api/cron/:id/trigger     Manually trigger a run
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, and, desc } from '@plexo/db'
import { cronJobs } from '@plexo/db'
import { logger } from '../logger.js'

export const cronRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Basic cron expression validation (5 or 6 field)
function isValidCron(expr: string): boolean {
    const parts = expr.trim().split(/\s+/)
    return parts.length >= 5 && parts.length <= 6
}

// ── GET /api/cron ─────────────────────────────────────────────────────────────

cronRouter.get('/', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const items = await db
            .select()
            .from(cronJobs)
            .where(eq(cronJobs.workspaceId, workspaceId))
            .orderBy(desc(cronJobs.createdAt))
        res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/cron failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list cron jobs' } })
    }
})

// ── POST /api/cron ────────────────────────────────────────────────────────────

cronRouter.post('/', async (req, res) => {
    const { workspaceId, name, schedule } = req.body as {
        workspaceId?: string
        name?: string
        schedule?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId) || !name || !schedule) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId, name, schedule required' } })
        return
    }

    if (!isValidCron(schedule)) {
        res.status(400).json({ error: { code: 'INVALID_SCHEDULE', message: 'Invalid cron expression' } })
        return
    }

    try {
        const [created] = await db.insert(cronJobs).values({
            workspaceId,
            name,
            schedule,
            enabled: true,
        }).returning()
        logger.info({ workspaceId, name, schedule }, 'Cron job created')
        res.status(201).json(created)
    } catch (err) {
        logger.error({ err }, 'POST /api/cron failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create cron job' } })
    }
})

// ── PATCH /api/cron/:id ───────────────────────────────────────────────────────

cronRouter.patch('/:id', async (req, res) => {
    const { id } = req.params
    const { workspaceId, enabled, schedule, name } = req.body as {
        workspaceId?: string
        enabled?: boolean
        schedule?: string
        name?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    if (schedule && !isValidCron(schedule)) {
        res.status(400).json({ error: { code: 'INVALID_SCHEDULE', message: 'Invalid cron expression' } })
        return
    }

    try {
        const update: Record<string, unknown> = {}
        if (enabled !== undefined) update.enabled = enabled
        if (schedule) update.schedule = schedule
        if (name) update.name = name

        await db.update(cronJobs)
            .set(update)
            .where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, id }, 'PATCH /api/cron/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── DELETE /api/cron/:id ──────────────────────────────────────────────────────

cronRouter.delete('/:id', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        await db.delete(cronJobs)
            .where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))
        logger.info({ id, workspaceId }, 'Cron job deleted')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, id }, 'DELETE /api/cron/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Delete failed' } })
    }
})

// ── POST /api/cron/:id/trigger ────────────────────────────────────────────────
// Manual trigger — creates a task immediately with type 'cron'

cronRouter.post('/:id/trigger', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.body as { workspaceId?: string }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const [job] = await db.select().from(cronJobs)
            .where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))
            .limit(1)

        if (!job) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Cron job not found' } })
            return
        }

        // Update lastRunAt to now (actual execution is external — the agent loop picks up tasks)
        await db.update(cronJobs)
            .set({ lastRunAt: new Date() })
            .where(eq(cronJobs.id, id))

        logger.info({ id, workspaceId, name: job.name }, 'Cron job manually triggered')
        res.json({ ok: true, message: `${job.name} triggered` })
    } catch (err) {
        logger.error({ err, id }, 'POST /api/cron/:id/trigger failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Trigger failed' } })
    }
})
