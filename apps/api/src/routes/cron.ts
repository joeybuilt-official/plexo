/**
 * Cron jobs API
 *
 * GET    /api/cron?workspaceId=    List cron jobs
 * POST   /api/cron/parse-nl       Parse natural language → cron expression
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

// Natural language → cron (deterministic, no AI call)
function parseNl(text: string): { cron: string; description: string } | null {
    const t = text.toLowerCase().trim()
    const pad = (n: number) => String(n).padStart(2, '0')

    // daily at HH(:MM)? (am|pm)?
    const dailyAt = t.match(/(?:every\s+day|daily)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
    if (dailyAt) {
        let h = parseInt(dailyAt[1]!)
        const m = parseInt(dailyAt[2] ?? '0')
        if (dailyAt[3] === 'pm' && h < 12) h += 12
        if (dailyAt[3] === 'am' && h === 12) h = 0
        return { cron: `${m} ${h} * * *`, description: `Daily at ${h}:${pad(m)}` }
    }

    // every N minutes
    const evMin = t.match(/every\s+(\d+)\s*min(?:ute)?s?/)
    if (evMin) { const n = +evMin[1]!; return { cron: `*/${n} * * * *`, description: `Every ${n} minutes` } }

    // every N hours
    const evHr = t.match(/every\s+(\d+)\s*hour(?:s)?/)
    if (evHr) { const n = +evHr[1]!; return { cron: `0 */${n} * * *`, description: `Every ${n} hours` } }

    // weekday at HH
    const dmap: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 }
    for (const [day, num] of Object.entries(dmap)) {
        const dm = t.match(new RegExp(`(?:every\\s+)?${day}s?\\s+(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?`))
        if (dm) {
            let h = parseInt(dm[1]!)
            const m = parseInt(dm[2] ?? '0')
            if (dm[3] === 'pm' && h < 12) h += 12
            if (dm[3] === 'am' && h === 12) h = 0
            return { cron: `${m} ${h} * * ${num}`, description: `Every ${day} at ${h}:${pad(m)}` }
        }
    }

    // Shorthands
    if (/every\s*5\s*min/.test(t)) return { cron: '*/5 * * * *', description: 'Every 5 minutes' }
    if (/every\s*15\s*min/.test(t)) return { cron: '*/15 * * * *', description: 'Every 15 minutes' }
    if (/every\s*30\s*min|half.*hour/.test(t)) return { cron: '*/30 * * * *', description: 'Every 30 minutes' }
    if (/hourly|every\s+hour/.test(t)) return { cron: '0 * * * *', description: 'Every hour' }
    if (/every\s*6\s*h/.test(t)) return { cron: '0 */6 * * *', description: 'Every 6 hours' }
    if (/every\s*12\s*h/.test(t)) return { cron: '0 */12 * * *', description: 'Every 12 hours' }
    if (/midnight/.test(t)) return { cron: '0 0 * * *', description: 'Daily at midnight' }
    if (/noon/.test(t)) return { cron: '0 12 * * *', description: 'Daily at noon' }
    if (/daily|every\s+day/.test(t)) return { cron: '0 0 * * *', description: 'Daily at midnight' }
    if (/weekly|every\s+week/.test(t)) return { cron: '0 9 * * 1', description: 'Weekly Mon 9am' }
    if (/monthly|every\s+month/.test(t)) return { cron: '0 0 1 * *', description: 'Monthly on the 1st' }

    // Raw cron passthrough
    if (isValidCron(t)) return { cron: t, description: 'Custom schedule' }
    return null
}

// ── POST /api/cron/parse-nl ───────────────────────────────────────────────────

cronRouter.post('/parse-nl', (req, res) => {
    const { text } = req.body as { text?: string }
    if (!text) {
        res.status(400).json({ error: { code: 'MISSING_TEXT', message: 'text required' } })
        return
    }
    const result = parseNl(text)
    if (!result) {
        res.status(422).json({ error: { code: 'PARSE_FAILED', message: 'Could not parse schedule from text' } })
        return
    }
    res.json(result)
})

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
