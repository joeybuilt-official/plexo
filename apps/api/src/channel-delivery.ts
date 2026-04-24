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
    // Auto-expire after 3 hours (matches the onAgentEvent listener timeout)
    setTimeout(() => _deliveredTasks.delete(taskId), 3 * 60 * 60 * 1000)
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
        }
        // Future: case 'slack', case 'discord', etc.
    } catch (err) {
        logger.warn({ err, taskId, channel: context.channel, chatId: context.chatId }, 'Channel delivery failed — results available in dashboard')
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

