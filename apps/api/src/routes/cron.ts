// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cron jobs API
 *
 * GET    /api/cron?workspaceId=&type=  List cron jobs (type=reminder|schedule|all)
 * POST   /api/cron/parse-nl            Parse natural language → cron expression
 * POST   /api/cron                     Create cron or one-shot reminder
 * PATCH  /api/cron/:id                 Update (schedule, scheduleAt, enabled, name, taskType, taskContext)
 * DELETE /api/cron/:id                 Delete
 * POST   /api/cron/:id/trigger         Manually trigger a run
 */
import { Router, type Router as RouterType } from 'express'
import { CronExpressionParser } from 'cron-parser'
import { db, eq, and, desc, isNull, isNotNull } from '@plexo/db'
import { cronJobs, channels, taskTypeEnum } from '@plexo/db'
import { push } from '@plexo/queue'
import type { TaskType } from '@plexo/db'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { isReminderSupportedChannelType, resolveRecipient } from '../lib/reminder-channel-registry.js'
import { decryptSensitiveConfigKeys } from '../lib/channel-config-crypto.js'

export const cronRouter: RouterType = Router()

const ALLOWED_TASK_TYPES: ReadonlySet<string> = new Set(taskTypeEnum.enumValues)
const REMINDER_HORIZON_MS = 365 * 24 * 60 * 60 * 1000 // 1 year — reject reminders further out
const REMINDER_PAST_BUFFER_MS = 1000 // 1s buffer guards clock skew between client/server
const REMINDER_MESSAGE_MAX = 4000
const REMINDER_MIN_CADENCE_MS = 5 * 60 * 1000 // recurring reminders must be ≥ 5 min apart
const NAME_MAX = 200 // matches channel-config convention

// ── Validation helpers ────────────────────────────────────────────────────────

// Basic cron expression validation (5 or 6 field)
function isValidCron(expr: string): boolean {
    const parts = expr.trim().split(/\s+/)
    return parts.length >= 5 && parts.length <= 6
}

function computeNextRunFromCron(schedule: string, after: Date): Date | null {
    try {
        const expr = CronExpressionParser.parse(schedule, { currentDate: after })
        const next = expr.next()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new Date((next as any).valueOf() as number)
    } catch {
        return null
    }
}

// Strict ISO 8601 with explicit timezone (Z or ±HH:MM). Rejects ambiguous local times.
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

function parseScheduleAt(input: string): Date | null {
    if (typeof input !== 'string' || !ISO_TZ_RE.test(input)) return null
    const t = Date.parse(input)
    if (!Number.isFinite(t)) return null
    return new Date(t)
}

export type ReminderValidationError =
    | { code: 'MISSING_TASK_CONTEXT'; message: string }
    | { code: 'MISSING_CHANNEL'; message: string }
    | { code: 'MISSING_MESSAGE'; message: string }
    | { code: 'MESSAGE_TOO_LONG'; message: string }

/**
 * Validate the *shape* of taskContext for a reminder. Channel-existence is
 * verified separately against the DB (workspace-scoped) — this is shape-only.
 */
export function validateReminderContext(ctx: unknown): ReminderValidationError | null {
    if (!ctx || typeof ctx !== 'object') {
        return { code: 'MISSING_TASK_CONTEXT', message: 'taskContext required for reminder' }
    }
    const c = ctx as Record<string, unknown>
    if (typeof c.channelId !== 'string' || c.channelId.trim().length === 0) {
        return { code: 'MISSING_CHANNEL', message: 'taskContext.channelId required (non-empty string)' }
    }
    if (typeof c.message !== 'string' || c.message.trim().length === 0) {
        return { code: 'MISSING_MESSAGE', message: 'taskContext.message required (non-empty string)' }
    }
    if (c.message.length > REMINDER_MESSAGE_MAX) {
        return { code: 'MESSAGE_TOO_LONG', message: `taskContext.message exceeds ${REMINDER_MESSAGE_MAX} chars` }
    }
    return null
}

/**
 * Verify a channel id exists, is enabled, and belongs to the given workspace.
 * IDOR guard: filter on (id, workspaceId) jointly — never trust the body alone.
 */
async function channelExistsInWorkspace(channelId: string, workspaceId: string): Promise<boolean> {
    if (!UUID_RE.test(channelId)) return false
    try {
        const [row] = await db.select({ id: channels.id, enabled: channels.enabled })
            .from(channels)
            .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
            .limit(1)
        return !!row && row.enabled === true
    } catch (err) {
        logger.warn({ err, channelId, workspaceId }, 'channelExistsInWorkspace lookup failed')
        return false
    }
}

/**
 * Fetch a channel scoped to (id, workspaceId) and require enabled=true.
 * Returns the row's id+type+config or null on miss/disabled/error. Used by
 * reminder validators that need to type-check + extract recipient via the
 * reminder-channel registry.
 */
async function fetchEnabledChannel(
    channelId: string,
    workspaceId: string,
): Promise<{ id: string; type: string; config: Record<string, unknown> } | null> {
    if (!UUID_RE.test(channelId)) return null
    try {
        const [row] = await db
            .select({ id: channels.id, type: channels.type, config: channels.config, enabled: channels.enabled })
            .from(channels)
            .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
            .limit(1)
        if (!row || row.enabled !== true) return null
        return { id: row.id, type: row.type as string, config: (row.config ?? {}) as Record<string, unknown> }
    } catch (err) {
        logger.warn({ err, channelId, workspaceId }, 'fetchEnabledChannel lookup failed')
        return null
    }
}

/**
 * Result of parseNl — one of:
 *   - recurring: { cron: '...', description: '...' }
 *   - one-shot:  { cron: null, scheduleAt: ISO_string, description: '...' }
 *   - error:     { error: 'PAST_TIME', description: '...' } (caller surfaces 422)
 *
 * Local-time interpretation in patterns like "tomorrow at 3pm" uses the
 * server's local timezone — the workspace TZ assumption Plexo carries
 * throughout. Output is always a UTC ISO string.
 */
type ParseNlResult =
    | { cron: string; description: string; scheduleAt?: undefined }
    | { cron: null; scheduleAt: string; description: string }
    | { error: 'PAST_TIME'; description: string }

const NL_INPUT_MAX = 200 // Vera: cap input length to bound regex DoS

// Natural language → cron OR one-shot scheduleAt (deterministic, no AI call)
function parseNl(text: string, now: Date = new Date()): ParseNlResult | null {
    if (text.length > NL_INPUT_MAX) return null
    const t = text.toLowerCase().trim()
    const pad = (n: number) => String(n).padStart(2, '0')
    const dmap: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 }

    // ── One-shot patterns (return { cron: null, scheduleAt, description }) ───

    // "in N minutes" / "in N hours" / "in N days"
    const inN = t.match(/^in\s+(\d+)\s*(minute|min|hour|hr|day)s?$/)
    if (inN) {
        const n = parseInt(inN[1]!)
        const unit = inN[2]!
        const ms = unit.startsWith('min') ? n * 60_000
            : unit.startsWith('h') ? n * 60 * 60_000
            : n * 24 * 60 * 60_000
        const at = new Date(now.getTime() + ms)
        return { cron: null, scheduleAt: at.toISOString(), description: `In ${n} ${unit}${n === 1 ? '' : 's'}` }
    }

    // "tomorrow at HH(:MM)?(am|pm)?"
    const tomAt = t.match(/^tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
    if (tomAt) {
        let h = parseInt(tomAt[1]!)
        const m = parseInt(tomAt[2] ?? '0')
        if (tomAt[3] === 'pm' && h < 12) h += 12
        if (tomAt[3] === 'am' && h === 12) h = 0
        const at = new Date(now)
        at.setDate(at.getDate() + 1)
        at.setHours(h, m, 0, 0)
        return { cron: null, scheduleAt: at.toISOString(), description: `Tomorrow at ${h}:${pad(m)}` }
    }

    // "today at HH(:MM)?(am|pm)?" — past time rolls forward to tomorrow
    const todAt = t.match(/^today\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
    if (todAt) {
        let h = parseInt(todAt[1]!)
        const m = parseInt(todAt[2] ?? '0')
        if (todAt[3] === 'pm' && h < 12) h += 12
        if (todAt[3] === 'am' && h === 12) h = 0
        const at = new Date(now)
        at.setHours(h, m, 0, 0)
        if (at.getTime() <= now.getTime()) {
            // Friendlier than 422: "today at 9am" said at 10am almost always meant tomorrow.
            at.setDate(at.getDate() + 1)
            return { cron: null, scheduleAt: at.toISOString(), description: `Tomorrow at ${h}:${pad(m)} (today already past)` }
        }
        return { cron: null, scheduleAt: at.toISOString(), description: `Today at ${h}:${pad(m)}` }
    }

    // "next Mon[day]/Tue[sday]/.../Sun[day] at HH(:MM)?(am|pm)?"
    const nextDay = t.match(/^next\s+(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
    if (nextDay) {
        const dayNum = dmap[nextDay[1]!]!
        let h = parseInt(nextDay[2]!)
        const m = parseInt(nextDay[3] ?? '0')
        if (nextDay[4] === 'pm' && h < 12) h += 12
        if (nextDay[4] === 'am' && h === 12) h = 0
        const at = new Date(now)
        const cur = at.getDay()
        // "next X" semantics: smallest delta in [1, 7] landing on dayNum.
        // Same-day match yields 7 (one week ahead) — the explicit "next".
        let delta = (dayNum - cur + 7) % 7
        if (delta === 0) delta = 7
        at.setDate(at.getDate() + delta)
        at.setHours(h, m, 0, 0)
        return { cron: null, scheduleAt: at.toISOString(), description: `Next ${nextDay[1]} at ${h}:${pad(m)}` }
    }

    // "at HH(:MM)?(am|pm)? on YYYY-MM-DD"
    const explicit = t.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+on\s+(\d{4})-(\d{2})-(\d{2})$/)
    if (explicit) {
        let h = parseInt(explicit[1]!)
        const m = parseInt(explicit[2] ?? '0')
        if (explicit[3] === 'pm' && h < 12) h += 12
        if (explicit[3] === 'am' && h === 12) h = 0
        const y = parseInt(explicit[4]!)
        const mo = parseInt(explicit[5]!) - 1
        const d = parseInt(explicit[6]!)
        const at = new Date(y, mo, d, h, m, 0, 0)
        if (Number.isNaN(at.getTime())) return null
        if (at.getTime() <= now.getTime()) {
            return { error: 'PAST_TIME', description: `${explicit[4]}-${explicit[5]}-${explicit[6]} ${h}:${pad(m)} is in the past` }
        }
        return { cron: null, scheduleAt: at.toISOString(), description: `${explicit[4]}-${explicit[5]}-${explicit[6]} at ${h}:${pad(m)}` }
    }

    // ── Recurring patterns (existing behavior) ──────────────────────────────

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

// Exported for unit tests — kept module-private otherwise.
export const __parseNlForTest = parseNl

// ── POST /api/cron/parse-nl ───────────────────────────────────────────────────

cronRouter.post('/parse-nl', (req, res) => {
    const { text } = req.body as { text?: string }
    if (!text) {
        res.status(400).json({ error: { code: 'MISSING_TEXT', message: 'text required' } })
        return
    }
    if (text.length > NL_INPUT_MAX) {
        res.status(400).json({ error: { code: 'INPUT_TOO_LONG', message: `text must be <= ${NL_INPUT_MAX} chars` } })
        return
    }
    const result = parseNl(text)
    if (!result) {
        res.status(422).json({ error: { code: 'PARSE_FAILED', message: 'Could not parse schedule from text' } })
        return
    }
    if ('error' in result) {
        res.status(422).json({ error: { code: result.error, message: result.description } })
        return
    }
    // One-shot: { cron: null, scheduleAt, description }. Recurring: { cron, description }.
    res.json(result)
})

// ── GET /api/cron ─────────────────────────────────────────────────────────────

cronRouter.get('/', async (req, res) => {
    const { workspaceId, type } = req.query as Record<string, string | undefined>
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (type !== undefined && type !== 'reminder' && type !== 'schedule' && type !== 'all') {
        res.status(400).json({ error: { code: 'INVALID_TYPE', message: 'type must be reminder|schedule|all' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    try {
        const wsFilter = eq(cronJobs.workspaceId, workspaceId)
        const where = type === 'reminder'
            ? and(wsFilter, isNull(cronJobs.schedule))
            : type === 'schedule'
                ? and(wsFilter, isNotNull(cronJobs.schedule))
                : wsFilter
        const items = await db
            .select()
            .from(cronJobs)
            .where(where)
            .orderBy(desc(cronJobs.createdAt))
        res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/cron failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list scheduled jobs' } })
    }
})

// ── POST /api/cron ────────────────────────────────────────────────────────────

cronRouter.post('/', async (req, res) => {
    const { workspaceId, name, schedule, scheduleAt, taskType, taskContext, prompt, repoUrl, branchRef, connectorIds, notifyChannel } = req.body as {
        workspaceId?: string
        name?: string
        schedule?: string
        scheduleAt?: string
        taskType?: string
        taskContext?: Record<string, unknown>
        prompt?: string
        repoUrl?: string
        branchRef?: string
        connectorIds?: string[]
        notifyChannel?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId) || !name) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId, name required' } })
        return
    }
    if (name.length > NAME_MAX) {
        res.status(400).json({ error: { code: 'NAME_TOO_LONG', message: `name must be <= ${NAME_MAX} chars` } })
        return
    }

    // XOR: exactly one fire mechanism
    const hasSchedule = typeof schedule === 'string' && schedule.length > 0
    const hasScheduleAt = typeof scheduleAt === 'string' && scheduleAt.length > 0
    if (hasSchedule === hasScheduleAt) {
        res.status(400).json({ error: { code: 'INVALID_FIRE_MECHANISM', message: 'Exactly one of schedule or scheduleAt required' } })
        return
    }

    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // Resolve schedule + nextRunAt from whichever mechanism is supplied
    let resolvedSchedule: string | null = null
    let resolvedNextRunAt: Date | null = null
    const now = new Date()

    if (hasSchedule) {
        if (!isValidCron(schedule!)) {
            res.status(400).json({ error: { code: 'INVALID_SCHEDULE', message: 'Invalid schedule expression' } })
            return
        }
        const next = computeNextRunFromCron(schedule!, now)
        if (!next) {
            res.status(400).json({ error: { code: 'INVALID_SCHEDULE', message: 'Schedule has no future fire time' } })
            return
        }
        resolvedSchedule = schedule!
        resolvedNextRunAt = next
        // Cadence floor: recurring reminders must fire ≥ REMINDER_MIN_CADENCE_MS apart.
        // Non-reminder system jobs (every-minute monitors etc.) keep their freedom.
        if ((taskType ?? 'general') === 'reminder') {
            try {
                const expr = CronExpressionParser.parse(schedule!, { currentDate: new Date() })
                const a = expr.next().toDate().getTime()
                const b = expr.next().toDate().getTime()
                if (b - a < REMINDER_MIN_CADENCE_MS) {
                    res.status(400).json({ error: { code: 'REMINDER_CADENCE_TOO_FREQUENT', message: 'Recurring reminders must be at least 5 minutes apart.' } })
                    return
                }
            } catch {
                // already validated isValidCron above; if parse blows up here, fall through
            }
        }
    } else {
        const parsed = parseScheduleAt(scheduleAt!)
        if (!parsed) {
            res.status(400).json({ error: { code: 'INVALID_SCHEDULE_AT', message: 'scheduleAt must be ISO 8601 with timezone' } })
            return
        }
        if (parsed.getTime() <= now.getTime() + REMINDER_PAST_BUFFER_MS) {
            res.status(400).json({ error: { code: 'SCHEDULE_AT_PAST', message: 'scheduleAt must be in the future' } })
            return
        }
        if (parsed.getTime() > now.getTime() + REMINDER_HORIZON_MS) {
            res.status(400).json({ error: { code: 'SCHEDULE_AT_TOO_FAR', message: 'scheduleAt must be within 1 year' } })
            return
        }
        resolvedNextRunAt = parsed
    }

    // taskType allow-list
    const resolvedTaskType = taskType ?? 'general'
    if (!ALLOWED_TASK_TYPES.has(resolvedTaskType)) {
        res.status(400).json({ error: { code: 'INVALID_TASK_TYPE', message: `taskType must be one of: ${[...ALLOWED_TASK_TYPES].join(', ')}` } })
        return
    }

    // Reminder-specific shape + workspace-scoped channel lookup. v1 ships
    // gmail-only; we type-check via the registry and derive chatId server-side
    // from channel.config.emailAddress (self-email — Lin's persona).
    let resolvedTaskContext: Record<string, unknown> = (taskContext ?? {}) as Record<string, unknown>
    if (resolvedTaskType === 'reminder') {
        const shapeErr = validateReminderContext(taskContext)
        if (shapeErr) {
            res.status(400).json({ error: shapeErr })
            return
        }
        const ctxIn = taskContext as Record<string, unknown>
        const channelId = ctxIn.channelId as string
        const channel = await fetchEnabledChannel(channelId, workspaceId)
        if (!channel) {
            res.status(400).json({ error: { code: 'CHANNEL_NOT_FOUND', message: 'channel not found, disabled, or not in this workspace' } })
            return
        }
        if (!isReminderSupportedChannelType(channel.type)) {
            res.status(400).json({ error: { code: 'REMINDER_CHANNEL_TYPE_NOT_SUPPORTED', message: 'Selected channel type is not supported for reminders. Supported types: gmail, twilio, telegram, slack, discord.' } })
            return
        }
        const chatId = resolveRecipient({
            type: channel.type,
            config: decryptSensitiveConfigKeys(channel.type, channel.config as Record<string, unknown>, workspaceId),
        })
        if (!chatId) {
            res.status(400).json({ error: { code: 'REMINDER_CHANNEL_NOT_CONFIGURED', message: 'Selected channel is missing a delivery address (e.g. emailAddress for Gmail).' } })
            return
        }
        resolvedTaskContext = {
            channel: channel.type,
            channelId: channel.id,
            chatId,
            message: ctxIn.message,
        }
    }

    try {
        const [created] = await db.insert(cronJobs).values({
            workspaceId,
            name,
            schedule: resolvedSchedule,
            nextRunAt: resolvedNextRunAt,
            enabled: true,
            taskType: resolvedTaskType,
            taskContext: resolvedTaskContext,
            prompt: prompt ?? null,
            repoUrl: repoUrl ?? null,
            branchRef: branchRef ?? 'main',
            connectorIds: connectorIds ?? [],
            notifyChannel: notifyChannel ?? null,
        }).returning()
        logger.info({ workspaceId, name, schedule: resolvedSchedule, scheduleAt: resolvedNextRunAt?.toISOString(), taskType: resolvedTaskType }, 'Schedule created')
        trackEvent('cron.created', 'info', { workspaceId, name, schedule: resolvedSchedule, taskType: resolvedTaskType })
        res.status(201).json(created)
    } catch (err) {
        logger.error({ err }, 'POST /api/cron failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create scheduled job' } })
    }
})

// ── PATCH /api/cron/:id ───────────────────────────────────────────────────────

cronRouter.patch('/:id', async (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    const { workspaceId, enabled, schedule, scheduleAt, name, taskType, taskContext, prompt, repoUrl, branchRef, connectorIds, notifyChannel } = req.body as {
        workspaceId?: string
        enabled?: boolean
        schedule?: string | null
        scheduleAt?: string | null
        name?: string
        taskType?: string
        taskContext?: Record<string, unknown>
        prompt?: string | null
        repoUrl?: string | null
        branchRef?: string
        connectorIds?: string[]
        notifyChannel?: string | null
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // If both supplied, reject — same rule as POST.
    const hasSchedule = typeof schedule === 'string' && schedule.length > 0
    const hasScheduleAt = typeof scheduleAt === 'string' && scheduleAt.length > 0
    if (hasSchedule && hasScheduleAt) {
        res.status(400).json({ error: { code: 'INVALID_FIRE_MECHANISM', message: 'Provide schedule or scheduleAt, not both' } })
        return
    }

    if (taskType !== undefined && !ALLOWED_TASK_TYPES.has(taskType)) {
        res.status(400).json({ error: { code: 'INVALID_TASK_TYPE', message: `taskType must be one of: ${[...ALLOWED_TASK_TYPES].join(', ')}` } })
        return
    }

    if (name !== undefined && name.length > NAME_MAX) {
        res.status(400).json({ error: { code: 'NAME_TOO_LONG', message: `name must be <= ${NAME_MAX} chars` } })
        return
    }

    // Determine effective taskType for reminder validation. Two cases must
    // re-run the channel check: (1) caller is switching to reminder, or
    // (2) caller is editing taskContext on a row that is already a reminder.
    let effectiveTaskType: string | undefined = taskType
    if (effectiveTaskType === undefined && taskContext !== undefined) {
        try {
            const [existing] = await db
                .select({ taskType: cronJobs.taskType })
                .from(cronJobs)
                .where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))
                .limit(1)
            if (existing) effectiveTaskType = existing.taskType as string
        } catch (err) {
            logger.warn({ err, id }, 'PATCH /api/cron/:id existing-row lookup failed')
        }
    }

    let resolvedTaskContext: Record<string, unknown> | undefined
    if (effectiveTaskType === 'reminder' && taskContext !== undefined) {
        const shapeErr = validateReminderContext(taskContext)
        if (shapeErr) {
            res.status(400).json({ error: shapeErr })
            return
        }
        const ctxIn = taskContext as Record<string, unknown>
        const channelId = ctxIn.channelId as string
        const channel = await fetchEnabledChannel(channelId, workspaceId)
        if (!channel) {
            res.status(400).json({ error: { code: 'CHANNEL_NOT_FOUND', message: 'channel not found, disabled, or not in this workspace' } })
            return
        }
        if (!isReminderSupportedChannelType(channel.type)) {
            res.status(400).json({ error: { code: 'REMINDER_CHANNEL_TYPE_NOT_SUPPORTED', message: 'Selected channel type is not supported for reminders. Supported types: gmail, twilio, telegram, slack, discord.' } })
            return
        }
        const chatId = resolveRecipient({
            type: channel.type,
            config: decryptSensitiveConfigKeys(channel.type, channel.config as Record<string, unknown>, workspaceId),
        })
        if (!chatId) {
            res.status(400).json({ error: { code: 'REMINDER_CHANNEL_NOT_CONFIGURED', message: 'Selected channel is missing a delivery address (e.g. emailAddress for Gmail).' } })
            return
        }
        resolvedTaskContext = {
            channel: channel.type,
            channelId: channel.id,
            chatId,
            message: ctxIn.message,
        }
    } else if (taskContext !== undefined) {
        resolvedTaskContext = taskContext
    }

    const update: Record<string, unknown> = {}
    if (enabled !== undefined) {
        update.enabled = enabled
        // L4.5 reminder revival: re-enabling a job clears the failure counter
        // so the dispatcher's "3 consecutive failures → auto-disable" guard
        // does not trip on the first failure post-revival. Operator decided
        // to retry — give them a fresh budget.
        if (enabled === true) update.consecutiveFailures = 0
    }
    if (name !== undefined) update.name = name
    if (taskType !== undefined) update.taskType = taskType
    if (resolvedTaskContext !== undefined) update.taskContext = resolvedTaskContext
    if (prompt !== undefined) update.prompt = prompt
    if (repoUrl !== undefined) update.repoUrl = repoUrl
    if (branchRef !== undefined) update.branchRef = branchRef
    if (connectorIds !== undefined) update.connectorIds = connectorIds
    if (notifyChannel !== undefined) update.notifyChannel = notifyChannel

    if (hasSchedule) {
        if (!isValidCron(schedule!)) {
            res.status(400).json({ error: { code: 'INVALID_SCHEDULE', message: 'Invalid schedule expression' } })
            return
        }
        const next = computeNextRunFromCron(schedule!, new Date())
        if (!next) {
            res.status(400).json({ error: { code: 'INVALID_SCHEDULE', message: 'Schedule has no future fire time' } })
            return
        }
        if (effectiveTaskType === 'reminder') {
            try {
                const expr = CronExpressionParser.parse(schedule!, { currentDate: new Date() })
                const a = expr.next().toDate().getTime()
                const b = expr.next().toDate().getTime()
                if (b - a < REMINDER_MIN_CADENCE_MS) {
                    res.status(400).json({ error: { code: 'REMINDER_CADENCE_TOO_FREQUENT', message: 'Recurring reminders must be at least 5 minutes apart.' } })
                    return
                }
            } catch { /* isValidCron already passed */ }
        }
        update.schedule = schedule
        update.nextRunAt = next
    } else if (hasScheduleAt) {
        const parsed = parseScheduleAt(scheduleAt!)
        if (!parsed) {
            res.status(400).json({ error: { code: 'INVALID_SCHEDULE_AT', message: 'scheduleAt must be ISO 8601 with timezone' } })
            return
        }
        const now = Date.now()
        if (parsed.getTime() <= now + REMINDER_PAST_BUFFER_MS) {
            res.status(400).json({ error: { code: 'SCHEDULE_AT_PAST', message: 'scheduleAt must be in the future' } })
            return
        }
        if (parsed.getTime() > now + REMINDER_HORIZON_MS) {
            res.status(400).json({ error: { code: 'SCHEDULE_AT_TOO_FAR', message: 'scheduleAt must be within 1 year' } })
            return
        }
        update.schedule = null
        update.nextRunAt = parsed
    }

    try {
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

    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        await db.delete(cronJobs)
            .where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))
        logger.info({ id, workspaceId }, 'Schedule deleted')
        trackEvent('cron.deleted', 'info', { cronId: id, workspaceId })
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

    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const [job] = await db.select().from(cronJobs)
            .where(and(eq(cronJobs.id, id), eq(cronJobs.workspaceId, workspaceId)))
            .limit(1)

        if (!job) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Scheduled job not found' } })
            return
        }

        // FUN-061: Push a task so the agent loop actually executes the cron job
        const taskId = await push({
            workspaceId,
            type: (job.taskType ?? 'general') as TaskType,
            source: 'cron',
            context: {
                ...(job.taskContext as Record<string, unknown> ?? {}),
                cronJobId: job.id,
                cronJobName: job.name,
                firedAt: new Date().toISOString(),
                manualTrigger: true,
            },
        })

        // Update lastRunAt to now
        await db.update(cronJobs)
            .set({ lastRunAt: new Date() })
            .where(eq(cronJobs.id, id))

        logger.info({ id, workspaceId, name: job.name, taskId }, 'Schedule manually triggered')
        trackEvent('cron.triggered', 'info', { cronId: id, workspaceId, name: job.name })
        res.json({ ok: true, taskId, message: `${job.name} triggered` })
    } catch (err) {
        logger.error({ err, id }, 'POST /api/cron/:id/trigger failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Trigger failed' } })
    }
})
