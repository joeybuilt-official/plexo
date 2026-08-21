// SPDX-License-Identifier: MIT
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
import type { TaskFailedPayload } from '@plexo/agent/tasks/types'
import {
    channelSupportsConfirmation,
    classifyConfirmCancel,
    extractConfirmationCode,
    formatTaskStateMessage,
    type TaskTransitionInput,
    type TaskTransitionState,
} from './channel-state-format.js'

// Re-export the pure helpers so existing call sites continue to import them
// from `./channel-delivery.js`. The implementation lives in
// `./channel-state-format.js` to keep the unit-testable surface free of the
// agent-stack transitive imports that channel-ai pulls in.
export {
    channelSupportsConfirmation,
    classifyConfirmCancel,
    extractConfirmationCode,
    formatTaskStateMessage,
    type TaskTransitionInput,
    type TaskTransitionState,
}

const TELEGRAM_API = 'https://api.telegram.org/bot'
const TG_MAX_LEN = 4096

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
        } else if (context.channel === 'twilio' && context.channelId && context.from) {
            await twilioSend(context.channelId as string, context.from as string, msg).catch(err => logger.warn({ err, taskId }, 'Twilio progress send failed'))
        } else if (context.channel === 'gmail' && context.channelId && context.from) {
            await gmailSendProgress(context, msg).catch(err => logger.warn({ err, taskId }, 'Gmail progress send failed'))
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

// ── Twilio outbound (SMS) ────────────────────────────────────────────────────

interface TwilioConfigShape { accountSid?: string; authToken?: string; fromNumber?: string }

async function loadTwilioConfig(channelId: string): Promise<{ accountSid: string; authToken: string; fromNumber: string } | null> {
    try {
        const { getById } = await import('./repositories/channels.repository.js')
        const row = await getById(channelId)
        if (!row || row.type !== 'twilio' || !row.enabled) return null
        const cfg = (row.config ?? {}) as TwilioConfigShape
        if (!cfg.accountSid || !cfg.authToken || !cfg.fromNumber) return null
        return { accountSid: cfg.accountSid, authToken: cfg.authToken, fromNumber: cfg.fromNumber }
    } catch (err) {
        logger.warn({ err, channelId }, 'Twilio: loadTwilioConfig failed')
        return null
    }
}

async function twilioSend(channelId: string, to: string, body: string): Promise<void> {
    const cfg = await loadTwilioConfig(channelId)
    if (!cfg) {
        logger.warn({ channelId }, 'Twilio: missing/disabled channel config — cannot deliver')
        return
    }
    try {
        // twilio-send module removed in DD-6c (multi-channel surface stripped).
        throw new Error('twilio-send module removed')
    } catch (err) {
        logger.warn({ err, channelId, to }, 'Twilio send threw')
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

    // ADR 0003 §pre-mortem Cause 2: refactor-to-switch threshold is 6-7 channels.
    // Channel count = 5 (telegram, slack, discord, twilio, gmail). Still under;
    // revisit this if/when a 6th channel lands.
    try {
        if (context.channel === 'telegram') {
            await deliverToTelegram(workspaceId, context.chatId, taskId, summary, assets, error, outcome)
        } else if (context.channel === 'slack') {
            const threadTs = typeof context.threadTs === 'string' ? context.threadTs : undefined
            await deliverToSlack(String(context.chatId), threadTs, summary, error, outcome)
        } else if (context.channel === 'discord') {
            await deliverToDiscord(String(context.chatId), summary, error, outcome)
        } else if (context.channel === 'twilio') {
            await deliverToTwilio(context, summary, error, outcome)
        } else if (context.channel === 'gmail') {
            await deliverToGmail(context, summary, error, outcome)
        }
    } catch (err) {
        logger.warn({ err, taskId, channel: context.channel, chatId: context.chatId }, 'Channel delivery failed — results available in dashboard')
    }
}

async function deliverToTwilio(
    context: TaskContext,
    summary: string,
    error: string | undefined,
    outcome: 'complete' | 'failed',
): Promise<void> {
    const channelId = typeof context.channelId === 'string' ? context.channelId : null
    const to = typeof context.from === 'string' ? context.from : (typeof context.chatId === 'string' ? context.chatId : null)
    if (!channelId || !to) {
        logger.warn({ channelId, to }, 'Twilio: missing channelId or recipient — cannot deliver')
        return
    }
    const text = outcome === 'failed'
        ? translateErrorForUser(error ?? 'Unknown error')
        : summary
    await twilioSend(channelId, to, text.slice(0, 1600))
}

// ── Gmail outbound (reply in-thread) ─────────────────────────────────────────

interface OutboundAttachment {
    filename: string
    mimeType: string
    bytes: Buffer
}

function readAttachments(context: TaskContext): OutboundAttachment[] | undefined {
    const raw = (context as { attachments?: unknown }).attachments
    if (!Array.isArray(raw)) return undefined
    const out: OutboundAttachment[] = []
    for (const a of raw) {
        if (!a || typeof a !== 'object') continue
        const r = a as { filename?: unknown; mimeType?: unknown; bytes?: unknown }
        if (typeof r.filename !== 'string' || typeof r.mimeType !== 'string') continue
        if (!Buffer.isBuffer(r.bytes)) continue
        out.push({ filename: r.filename, mimeType: r.mimeType, bytes: r.bytes })
    }
    return out.length > 0 ? out : undefined
}

async function gmailSendProgress(context: TaskContext, text: string): Promise<void> {
    const channelId = typeof context.channelId === 'string' ? context.channelId : null
    const to = typeof context.from === 'string' ? context.from : (typeof context.chatId === 'string' ? context.chatId : null)
    if (!channelId || !to) return
    const subject = buildGmailSubject(context)
    const threadId = typeof context.threadId === 'string' ? context.threadId : undefined
    const inReplyTo = typeof context.messageId === 'string' ? context.messageId : undefined
    const attachments = readAttachments(context)
    try {
        // gmail-send module removed in DD-6c (multi-channel surface stripped).
        throw new Error('gmail-send module removed')
    } catch (err) {
        logger.warn({ err, channelId }, 'Gmail progress send threw')
    }
}

function buildGmailSubject(context: TaskContext): string {
    const original = typeof context.subject === 'string' ? context.subject : ''
    if (original) {
        return /^re:/i.test(original) ? original : `Re: ${original}`
    }
    return 'Re: Plexo task complete'
}

export async function deliverToGmail(
    context: TaskContext,
    summary: string,
    error: string | undefined,
    outcome: 'complete' | 'failed',
): Promise<void> {
    const channelId = typeof context.channelId === 'string' ? context.channelId : null
    const to = typeof context.from === 'string' ? context.from : (typeof context.chatId === 'string' ? context.chatId : null)
    if (!channelId || !to) {
        throw new Error(`Gmail: missing channelId or recipient (channelId=${channelId}, to=${to})`)
    }
    const body = outcome === 'failed'
        ? translateErrorForUser(error ?? 'Unknown error')
        : summary
    const subject = buildGmailSubject(context)
    const threadId = typeof context.threadId === 'string' ? context.threadId : undefined
    const inReplyTo = typeof context.messageId === 'string' ? context.messageId : undefined
    const attachments = readAttachments(context)
    // gmail-send module removed in DD-6c (multi-channel surface stripped).
    void attachments
    throw new Error('gmail-send module removed — Gmail delivery unavailable')
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
            const { getTelegramChannelForWorkspace } = await import('./repositories/channels.repository.js')
            const row = await getTelegramChannelForWorkspace(workspaceId)
            const cfg = (row?.config ?? {}) as { token?: string; bot_token?: string } | null
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
//
// The pure helpers (formatTaskStateMessage, classifyConfirmCancel,
// extractConfirmationCode, channelSupportsConfirmation) live in
// channel-state-format.ts so they can be unit-tested without dragging in the
// agent-stack transitive imports that channel-ai.ts pulls. They are
// re-exported above so existing call sites continue to import from this file.
// ─────────────────────────────────────────────────────────────────────────────

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
        if (context.channel === 'twilio') {
            const channelId = typeof context.channelId === 'string' ? context.channelId : null
            const to = typeof context.from === 'string' ? context.from : String(context.chatId)
            if (channelId && to) await twilioSend(channelId, to, text.slice(0, 1600))
            return
        }
        if (context.channel === 'gmail') {
            const channelId = typeof context.channelId === 'string' ? context.channelId : null
            const to = typeof context.from === 'string' ? context.from : String(context.chatId)
            if (channelId && to) await gmailSendProgress(context, text)
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

            // No isTaskDelivered guard for failures: the bus listener is now
            // the single owner of failure delivery on telegram/slack/discord
            // (the parallel in-memory failure branch in routes/telegram.ts was
            // removed). markTaskDelivered/isTaskDelivered remain in use for
            // the SUCCESS path's de-dup between telegram's onAgentEvent and
            // any DB-backed re-delivery — failures never participate.

            // Look up the task to find the originating channelRef. The event
            // payload deliberately doesn't carry it (it's a memory/audit
            // signal); channel context lives on `tasks.context`.
            const { db } = await import('@plexo/db')
            const { eq } = await import('drizzle-orm')
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

export async function handleInboundConfirmCancel(params: {
    workspaceId: string
    channel: 'telegram' | 'slack' | 'discord'
    chatId: string | number
    text: string
    decidedBy: string
}): Promise<{ outcome: ConfirmCancelOutcome; taskId?: string; approvalId?: string }> {
    const verdict = classifyConfirmCancel(params.text)
    if (!verdict) return { outcome: 'not_a_command' }

    const code = extractConfirmationCode(params.text)

    try {
        const { db } = await import('@plexo/db')
        const { eq, and, sql, desc } = await import('drizzle-orm')
        const { tasks } = await import('@plexo/db')
        // Match awaiting_approval tasks whose channelRef points at this chat.
        // JSONB containment via `context @> {...}` keeps an index path for
        // json predicates. Pull a small recent window so we can disambiguate
        // multiple pending approvals via the supplied 6-char code.
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
            .limit(5)

        if (rows.length === 0) return { outcome: 'no_pending' }

        // Resolve which row the user meant.
        let chosen: typeof rows[number] | null = null
        let chosenApprovalId: string | undefined
        if (code) {
            for (const r of rows) {
                const id = (r.context as Record<string, unknown> | null)?._approvalId as string | undefined
                if (id && id.toLowerCase().startsWith(code)) {
                    chosen = r
                    chosenApprovalId = id
                    break
                }
            }
            if (!chosen) {
                // User supplied a code but it didn't match any pending approval
                // for this chat — treat as expired/already-resolved rather than
                // accidentally confirming the wrong task.
                return { outcome: 'expired' }
            }
        } else {
            // No code supplied: fall back to the most-recent awaiting_approval.
            chosen = rows[0]!
            chosenApprovalId = (chosen.context as Record<string, unknown> | null)?._approvalId as string | undefined
        }

        if (!chosenApprovalId) {
            logger.warn({ taskId: chosen.id }, 'awaiting_approval task has no _approvalId in context — cannot resolve confirmation reply')
            return { outcome: 'no_pending', taskId: chosen.id }
        }

        const { resolveDecision, getDecision } = await import('@plexo/agent/one-way-door')
        // Pre-check so an already-resolved or expired record gets a clear outcome
        // rather than falling through resolveDecision's null return.
        const existing = await getDecision(chosenApprovalId)
        if (!existing || existing.decision !== 'pending') {
            return { outcome: 'expired', taskId: chosen.id, approvalId: chosenApprovalId }
        }

        const decided = await resolveDecision(
            chosenApprovalId,
            verdict === 'confirm' ? 'approved' : 'rejected',
            params.decidedBy,
        )
        if (!decided) return { outcome: 'expired', taskId: chosen.id, approvalId: chosenApprovalId }
        return {
            outcome: verdict === 'confirm' ? 'approved' : 'cancelled',
            taskId: chosen.id,
            approvalId: chosenApprovalId,
        }
    } catch (err) {
        logger.warn({ err, channel: params.channel, chatId: params.chatId }, 'handleInboundConfirmCancel failed')
        return { outcome: 'no_pending' }
    }
}

