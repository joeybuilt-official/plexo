// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Persistent channel delivery — ensures task results reach the originating channel.
 *
 * This replaces the closure-based delivery in telegram.ts which dies on process restart.
 * The task's `context` field stores the originating channel info at queue time.
 * This module reads that context at completion time and delivers results.
 *
 * Supports: telegram (more channels added as adapters are built).
 */

import { logger } from './logger.js'
import { startProgressReporter } from './task-progress.js'
import { translateErrorForUser } from './channel-ai.js'
import type { EscalationSummary, TaskFailedPayload } from '@plexo/agent/tasks/types'

const TELEGRAM_API = 'https://api.telegram.org/bot'
const TG_MAX_LEN = 4096

// ── Channels that support inbound CONFIRM/CANCEL replies ─────────────────────
// Web does not — its confirmation surface is the SSE-driven /app/approvals view.
const CONFIRMATION_CHANNELS = new Set(['telegram', 'slack', 'discord'])

export function channelSupportsConfirmation(channel: string | undefined): boolean {
    return !!channel && CONFIRMATION_CHANNELS.has(channel)
}

// ── Token registry (populated by channel adapters on init) ───────────────────

/** workspaceId → bot token */
const workspaceTokens = new Map<string, string>()

/** Register a Telegram bot token for a workspace (called by telegram.ts on init) */
export function registerChannelToken(workspaceId: string, token: string): void {
    workspaceTokens.set(workspaceId, token)
}

/** Get the Telegram bot token for a workspace */
export function getChannelToken(workspaceId: string): string | undefined {
    return workspaceTokens.get(workspaceId)
}

// ── In-memory delivery dedup ────────────────────────────────────────────────
// When a Telegram in-memory listener (onAgentEvent in telegram.ts) is active,
// it delivers results directly. This set prevents deliverToOriginChannel from
// sending a duplicate message for the same task.
const _deliveredTasks = new Set<string>()

/** Mark a task as having an active in-memory listener. Prevents duplicate delivery. */
export function markTaskDelivered(taskId: string): void {
    _deliveredTasks.add(taskId)
    // Auto-expire after 3 hours as a backstop. Channel adapters should call
    // unmarkTaskDelivered() explicitly when their listener expires without a
    // terminal event, so DB-backed delivery can take over.
    setTimeout(() => _deliveredTasks.delete(taskId), 3 * 60 * 60 * 1000)
}

/**
 * Clear the dedup flag so DB-backed delivery takes over. Call this when an
 * in-memory listener gives up before the task reaches a terminal state
 * (e.g., the listener's own timeout fires for a long-running task).
 */
export function unmarkTaskDelivered(taskId: string): void {
    _deliveredTasks.delete(taskId)
}

/** Check if a task has an active in-memory listener (skip DB-backed delivery + progress). */
export function isTaskDelivered(taskId: string): boolean {
    return _deliveredTasks.has(taskId)
}

// ── Delivery ─────────────────────────────────────────────────────────────────

interface TaskContext {
    channel?: string
    chatId?: string | number
    description?: string
    [key: string]: unknown
}

interface DeliveryPayload {
    taskId: string
    workspaceId: string
    context: TaskContext
    summary: string
    assets?: string[]
    error?: string
    outcome: 'complete' | 'failed'
}

// ── Progress updates ─────────────────────────────────────────────────────────

/**
 * Start periodic progress updates for a running task and return a cleanup fn.
 *
 * Called from agent-loop.ts right after task_started. Works for all channels —
 * the channel type is read from the task's stored context.
 */
export function startTaskProgressUpdates(taskId: string, workspaceId: string, context: TaskContext): () => void {
    if (!context.channel) return () => {}
    // Skip if an in-memory listener is handling progress for this task (prevents duplicate progress messages)
    if (isTaskDelivered(taskId)) return () => {}

    // Telegram: edit a single progress message in-place instead of spamming new ones
    let _tgProgressMsgId: number | null = null

    const send = async (msg: string): Promise<void> => {
        if (context.channel === 'telegram' && context.chatId) {
            const token = workspaceTokens.get(workspaceId)
            if (token) {
                if (_tgProgressMsgId) {
                    // Edit existing message in-place
                    await tgEdit(token, context.chatId, _tgProgressMsgId, msg).catch(err => logger.warn({ err, taskId }, 'Telegram progress edit failed'))
                } else {
                    // First progress update: send new message, save ID
                    _tgProgressMsgId = await tgSendGetId(token, context.chatId, msg).catch(err => { logger.warn({ err, taskId }, 'Telegram progress send failed'); return null })
                }
            }
        } else if (context.channel === 'slack' && context.slackChannel) {
            await slackSend(context.slackChannel as string, msg, context.threadTs as string | undefined).catch(err => logger.warn({ err, taskId }, 'Slack progress send failed'))
        } else if (context.channel === 'discord' && context.channelId) {
            await discordSend(context.channelId as string, msg).catch(err => logger.warn({ err, taskId }, 'Discord progress send failed'))
        }
    }

    return startProgressReporter(taskId, send)
}

// ── Slack progress sender ────────────────────────────────────────────────────

async function slackSend(channel: string, text: string, threadTs?: string): Promise<void> {
    const token = process.env.SLACK_BOT_TOKEN
    if (!token) return
    try {
        await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ channel, text, thread_ts: threadTs }),
            signal: AbortSignal.timeout(10_000),
        })
    } catch (err) {
        logger.warn({ err, channel }, 'Slack progress send failed')
    }
}

// ── Discord progress sender ───────────────────────────────────────────────────

async function discordSend(channelId: string, content: string): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN
    if (!token) return
    try {
        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
            body: JSON.stringify({ content }),
            signal: AbortSignal.timeout(10_000),
        })
    } catch (err) {
        logger.warn({ err, channelId }, 'Discord progress send failed')
    }
}

/**
 * Deliver task results to the originating channel.
 *
 * Called from agent-loop.ts on every task completion/failure.
 * Reads channel info from the task's stored context — no closures, survives restarts.
 */
export async function deliverToOriginChannel(payload: DeliveryPayload): Promise<void> {
    const { taskId, workspaceId, context, summary, assets, error, outcome } = payload

    if (!context.channel || !context.chatId) return // Not from a channel — skip silently

    // Skip if an in-memory listener already delivered this task (prevents duplicate messages)
    if (isTaskDelivered(taskId)) {
        logger.debug({ taskId, channel: context.channel }, 'Channel delivery skipped — in-memory listener already delivered')
        return
    }

    try {
        if (context.channel === 'telegram') {
            await deliverToTelegram(workspaceId, context.chatId, taskId, summary, assets, error, outcome)
        } else if (context.channel === 'slack') {
            const threadTs = typeof context.threadTs === 'string' ? context.threadTs : undefined
            await deliverToSlack(String(context.chatId), threadTs, summary, error, outcome)
        } else if (context.channel === 'discord') {
            await deliverToDiscord(String(context.chatId), summary, error, outcome)
        }
    } catch (err) {
        logger.warn({ err, taskId, channel: context.channel, chatId: context.chatId }, 'Channel delivery failed — results available in dashboard')
    }
}

// ── Slack final delivery ─────────────────────────────────────────────────────

async function deliverToSlack(
    channel: string,
    threadTs: string | undefined,
    summary: string,
    error: string | undefined,
    outcome: 'complete' | 'failed',
): Promise<void> {
    const token = process.env.SLACK_BOT_TOKEN
    if (!token) {
        logger.warn({ channel }, 'No SLACK_BOT_TOKEN — cannot deliver task result')
        return
    }
    const text = outcome === 'failed'
        ? translateErrorForUser(error ?? 'Unknown error')
        : `✅ ${summary}`
    try {
        await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ channel, text, thread_ts: threadTs }),
            signal: AbortSignal.timeout(10_000),
        })
    } catch (err) {
        logger.warn({ err, channel }, 'Slack final delivery failed')
    }
}

// ── Discord final delivery ───────────────────────────────────────────────────

async function deliverToDiscord(
    channelId: string,
    summary: string,
    error: string | undefined,
    outcome: 'complete' | 'failed',
): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN
    if (!token) {
        logger.warn({ channelId }, 'No DISCORD_BOT_TOKEN — cannot deliver task result')
        return
    }
    const content = outcome === 'failed'
        ? translateErrorForUser(error ?? 'Unknown error')
        : `✅ ${summary}`
    try {
        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
            body: JSON.stringify({ content: content.slice(0, 2000) }),
            signal: AbortSignal.timeout(10_000),
        })
    } catch (err) {
        logger.warn({ err, channelId }, 'Discord final delivery failed')
    }
}

// ── Telegram delivery ────────────────────────────────────────────────────────

async function deliverToTelegram(
    workspaceId: string,
    chatId: string | number,
    taskId: string,
    summary: string,
    assets: string[] | undefined,
    error: string | undefined,
    outcome: 'complete' | 'failed',
): Promise<void> {
    const token = workspaceTokens.get(workspaceId)
    if (!token) {
        // Try to load from DB as fallback
        try {
            const { db, eq } = await import('@plexo/db')
            const { channels } = await import('@plexo/db')
            const [row] = await db.select({ config: channels.config })
                .from(channels)
                .where(eq(channels.workspaceId, workspaceId))
                .limit(1)
            const cfg = row?.config as { token?: string; bot_token?: string } | null
            const dbToken = cfg?.token ?? cfg?.bot_token
            if (dbToken) {
                workspaceTokens.set(workspaceId, dbToken)
                return deliverToTelegram(workspaceId, chatId, taskId, summary, assets, error, outcome)
            }
        } catch (dbErr) {
            logger.warn({ err: dbErr, workspaceId, taskId }, 'Failed to load Telegram token from DB')
        }
        logger.warn({ workspaceId, taskId }, 'No Telegram token available for workspace — cannot deliver')
        return
    }

    if (outcome === 'failed') {
        // P9: translate errors — never relay raw error strings
        const translated = translateErrorForUser(error ?? 'Unknown error')
        await tgSend(token, chatId, translated)
        return
    }

    // Send image assets first (if any)
    const imageAssets = (assets ?? []).filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
    if (imageAssets.length > 0) {
        const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3000'
        const photoUrl = `${publicUrl}/api/v1/tasks/${taskId}/assets/${imageAssets[0]}`
        try {
            const photoRes = await fetch(`${TELEGRAM_API}${token}/sendPhoto`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    photo: photoUrl,
                    caption: summary.slice(0, 1024),
                    parse_mode: 'Markdown',
                }),
                signal: AbortSignal.timeout(10_000),
            })
            if (!photoRes.ok) {
                logger.warn({ status: photoRes.status, taskId }, 'Telegram sendPhoto failed — falling back to text')
                await tgSend(token, chatId, summary)
            }
        } catch {
            await tgSend(token, chatId, `✅ ${summary}`)
        }
    } else {
        // Send summary only — full report is in the dashboard.
        await tgSend(token, chatId, `✅ ${summary}`)
    }
}

async function tgSend(token: string, chatId: string | number, text: string): Promise<void> {
    try {
        await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
            signal: AbortSignal.timeout(10_000),
        })
    } catch (err) {
        logger.warn({ err, chatId }, 'Telegram send failed')
    }
}

async function tgSendGetId(token: string, chatId: string | number, text: string): Promise<number | null> {
    try {
        const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
            signal: AbortSignal.timeout(10_000),
        })
        const data = await res.json() as { ok?: boolean; result?: { message_id?: number } }
        return data.result?.message_id ?? null
    } catch {
        return null
    }
}

async function tgEdit(token: string, chatId: string | number, messageId: number, text: string): Promise<void> {
    try {
        await fetch(`${TELEGRAM_API}${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' }),
            signal: AbortSignal.timeout(10_000),
        })
    } catch { /* edit failures are non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — task state-transition notifications
//
// One message per major state transition (planning, awaiting_confirmation,
// completed, failed, cancelled). Per-step messages are only sent when the
// task or workspace opts into verbose mode. Wired from agent-loop.ts at each
// recordTaskEvent site, and from a TASK_FAILED listener for any path that
// reaches markTaskFailed (sweepers, executor catch, approval rejected, etc.).
// ─────────────────────────────────────────────────────────────────────────────

export type TaskTransitionState =
    | 'planning'
    | 'awaiting_confirmation'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'step_complete'

export interface TaskTransitionInput {
    state: TaskTransitionState
    /** User-facing task title or description (truncated for display). */
    title?: string
    /** For awaiting_confirmation: number of one-way-door steps the user is being asked to approve. */
    stepCount?: number
    /**
     * Short code shown to the user with CONFIRM/CANCEL prompts. Caller derives
     * this from the OWD approval id (typically the first 6 hex chars of the
     * 24-char id). Inbound CONFIRM/CANCEL handlers map back via the originating
     * task's `context._approvalId`, so the code is informational — not used
     * for lookup.
     */
    confirmationCode?: string
    /** For failed: 4-field escalation summary (Krishnamurthy). */
    summary?: EscalationSummary
    /** For completed: short single-line outcome the user sees. */
    completedSummary?: string
    /** For cancelled: optional reason string. */
    cancelReason?: string
    /** Set true to emit step_complete messages. Off by default. */
    verbose?: boolean
}

const TITLE_MAX = 100

function clipTitle(title: string | undefined): string {
    const t = (title ?? '').trim()
    if (!t) return 'your task'
    return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + '…' : t
}

/**
 * Format a state transition into a single channel-agnostic message.
 * Returns null when the transition should be silent (e.g. step_complete in
 * non-verbose mode).
 */
export function formatTaskStateMessage(input: TaskTransitionInput): string | null {
    switch (input.state) {
        case 'planning':
            return `📝 Working on a plan for: *${clipTitle(input.title)}*`
        case 'awaiting_confirmation': {
            const n = input.stepCount && input.stepCount > 0 ? input.stepCount : 1
            const noun = n === 1 ? 'irreversible step' : `${n} irreversible steps`
            const code = input.confirmationCode
            const replyLine = code
                ? `Reply *CONFIRM ${code}* to proceed or *CANCEL ${code}* to abort.`
                : `Reply *CONFIRM* to proceed or *CANCEL* to abort.`
            return `⏸️ *${clipTitle(input.title)}* is ready, but it would do ${noun}.\n${replyLine}`
        }
        case 'completed':
            return `✅ ${input.completedSummary?.trim() || 'Task complete.'}`
        case 'failed': {
            const s = input.summary
            if (!s) return `❌ Task failed.`
            const recoverable = s.recoverable
                ? `_(recoverable — you can resume from where it stopped)_`
                : `_(not recoverable — restart needed)_`
            return [
                `❌ *${s.what}*`,
                ``,
                `*Why:* ${s.why}`,
                `*Next:* ${s.action}`,
                recoverable,
            ].join('\n')
        }
        case 'cancelled':
            return input.cancelReason
                ? `🚫 Task cancelled: ${input.cancelReason}`
                : `🚫 Task cancelled.`
        case 'step_complete':
            return input.verbose ? `Step complete.` : null
        default:
            return null
    }
}

interface TaskTransitionTarget {
    taskId: string
    workspaceId: string
    /** Originating channel context — typically `task.context` from the DB row. */
    context: TaskContext
}

/**
 * Deliver a single state-transition message to the originating channel.
 *
 * Skips silently when:
 *   - the task has no channelRef (web/api task)
 *   - the formatter returns null (e.g. step_complete with verbose=false)
 *   - the channel has no token configured
 *
 * Failures are swallowed and logged at warn level — channel delivery must
 * never block task progress or terminal-state writes.
 */
export async function deliverTaskTransition(
    target: TaskTransitionTarget,
    input: TaskTransitionInput,
): Promise<void> {
    const { taskId, workspaceId, context } = target
    if (!context.channel || !context.chatId) return

    const text = formatTaskStateMessage(input)
    if (!text) return

    try {
        if (context.channel === 'telegram') {
            const token = workspaceTokens.get(workspaceId)
            if (!token) {
                logger.debug({ taskId, workspaceId }, 'deliverTaskTransition: no telegram token, skipping')
                return
            }
            await tgSend(token, context.chatId, text.slice(0, TG_MAX_LEN))
            return
        }
        if (context.channel === 'slack') {
            const threadTs = typeof context.threadTs === 'string' ? context.threadTs : undefined
            await slackSend(String(context.chatId), text, threadTs)
            return
        }
        if (context.channel === 'discord') {
            await discordSend(String(context.chatId), text.slice(0, 2000))
            return
        }
    } catch (err) {
        logger.warn({ err, taskId, channel: context.channel, state: input.state }, 'Task transition delivery failed')
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK_FAILED listener
//
// Subscribes to the agent event bus and delivers the 4-field escalation
// summary to the originating channel for any task that goes through
// `markTaskFailed`. Sibling to `reflect.ts` (memory) and
// `consolidation.ts` (anti-bloat) which subscribe to the same topic.
// Idempotent — a re-import during HMR or tests does not double-subscribe.
// ─────────────────────────────────────────────────────────────────────────────

let _taskFailedListenerInitialized = false

export async function initTaskFailedListener(): Promise<void> {
    if (_taskFailedListenerInitialized) return
    _taskFailedListenerInitialized = true

    const { eventBus, TOPICS } = await import('@plexo/agent/event-bus')

    eventBus.subscribe(TOPICS.TASK_FAILED, async (raw: unknown) => {
        try {
            const payload = raw as TaskFailedPayload
            if (!payload?.taskId || !payload.workspaceId) return

            // Look up the task to find the originating channelRef. The event
            // payload deliberately doesn't carry it (it's a memory/audit
            // signal); channel context lives on `tasks.context`.
            const { db, eq } = await import('@plexo/db')
            const { tasks } = await import('@plexo/db')
            const [row] = await db.select({ context: tasks.context })
                .from(tasks)
                .where(eq(tasks.id, payload.taskId))
                .limit(1)
            const ctx = (row?.context as TaskContext | null) ?? {}
            if (!ctx.channel || !ctx.chatId) return

            await deliverTaskTransition(
                { taskId: payload.taskId, workspaceId: payload.workspaceId, context: ctx },
                {
                    state: 'failed',
                    title: ctx.description,
                    summary: payload.summary ?? undefined,
                },
            )
        } catch (err) {
            logger.warn({ err }, 'TASK_FAILED channel delivery listener errored — non-fatal')
        }
    })

    logger.info('TASK_FAILED channel-delivery listener registered')
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound CONFIRM / CANCEL handler
//
// Channels with supportsConfirmation=true (telegram/slack/discord) call this
// when a user replies to an awaiting_confirmation prompt. We look up the
// most-recent task in `awaiting_approval` for the workspace whose
// originating channelRef matches the inbound chat, read its
// `context._approvalId` (set in agent-loop when transitioning), and resolve
// the OWD record via the existing approval pipeline.
//
// Returns:
//   - 'approved' / 'cancelled' / 'expired' on a valid CONFIRM/CANCEL reply
//   - 'no_pending' when nothing was awaiting confirmation for this chat
//   - 'not_a_command' when the text isn't CONFIRM or CANCEL
// ─────────────────────────────────────────────────────────────────────────────

export type ConfirmCancelOutcome =
    | 'approved'
    | 'cancelled'
    | 'expired'
    | 'no_pending'
    | 'not_a_command'

const CONFIRM_RE = /^\s*(confirm|approve|yes|y|ok)\b/i
const CANCEL_RE = /^\s*(cancel|reject|abort|no|n|stop)\b/i

export function classifyConfirmCancel(text: string): 'confirm' | 'cancel' | null {
    if (CONFIRM_RE.test(text)) return 'confirm'
    if (CANCEL_RE.test(text)) return 'cancel'
    return null
}

export async function handleInboundConfirmCancel(params: {
    workspaceId: string
    channel: 'telegram' | 'slack' | 'discord'
    chatId: string | number
    text: string
    decidedBy: string
}): Promise<{ outcome: ConfirmCancelOutcome; taskId?: string; approvalId?: string }> {
    const verdict = classifyConfirmCancel(params.text)
    if (!verdict) return { outcome: 'not_a_command' }

    try {
        const { db, eq, and, sql, desc } = await import('@plexo/db')
        const { tasks } = await import('@plexo/db')
        // Match the most recent awaiting_approval task whose channelRef points
        // at this chat. JSONB containment via `context @> {...}` keeps the index
        // path for json predicates.
        const filter = JSON.stringify({ channel: params.channel, chatId: String(params.chatId) })
        const numericFilter = JSON.stringify({ channel: params.channel, chatId: Number(params.chatId) })
        const rows = await db.select({ id: tasks.id, context: tasks.context })
            .from(tasks)
            .where(and(
                eq(tasks.workspaceId, params.workspaceId),
                eq(tasks.status, 'awaiting_approval'),
                sql`(${tasks.context} @> ${filter}::jsonb OR ${tasks.context} @> ${numericFilter}::jsonb)`,
            ))
            .orderBy(desc(tasks.createdAt))
            .limit(1)

        const row = rows[0]
        if (!row) return { outcome: 'no_pending' }

        const ctx = (row.context as Record<string, unknown> | null) ?? {}
        const approvalId = ctx._approvalId as string | undefined
        if (!approvalId) {
            logger.warn({ taskId: row.id }, 'awaiting_approval task has no _approvalId in context — cannot resolve confirmation reply')
            return { outcome: 'no_pending', taskId: row.id }
        }

        const { resolveDecision, getDecision } = await import('@plexo/agent/one-way-door')
        // Pre-check so an already-resolved or expired record gets a clear outcome
        // rather than falling through resolveDecision's null return.
        const existing = await getDecision(approvalId)
        if (!existing || existing.decision !== 'pending') {
            return { outcome: 'expired', taskId: row.id, approvalId }
        }

        const decided = await resolveDecision(
            approvalId,
            verdict === 'confirm' ? 'approved' : 'rejected',
            params.decidedBy,
        )
        if (!decided) return { outcome: 'expired', taskId: row.id, approvalId }
        return {
            outcome: verdict === 'confirm' ? 'approved' : 'cancelled',
            taskId: row.id,
            approvalId,
        }
    } catch (err) {
        logger.warn({ err, channel: params.channel, chatId: params.chatId }, 'handleInboundConfirmCancel failed')
        return { outcome: 'no_pending' }
    }
}

