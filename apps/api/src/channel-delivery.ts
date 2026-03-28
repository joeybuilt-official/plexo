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

/**
 * Deliver task results to the originating channel.
 *
 * Called from agent-loop.ts on every task completion/failure.
 * Reads channel info from the task's stored context — no closures, survives restarts.
 */
export async function deliverToOriginChannel(payload: DeliveryPayload): Promise<void> {
    const { taskId, workspaceId, context, summary, assets, error, outcome } = payload

    if (!context.channel || !context.chatId) return // Not from a channel — skip silently

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
        } catch { /* fall through */ }
        logger.warn({ workspaceId, taskId }, 'No Telegram token available for workspace — cannot deliver')
        return
    }

    if (outcome === 'failed') {
        await tgSend(token, chatId, `❌ Task failed: ${error ?? 'Unknown error'}`)
        return
    }

    // Send summary
    await tgSend(token, chatId, `✅ ${summary}`)

    // Deliver text asset content
    const content = await readTaskAssets(taskId)
    if (content) {
        const chunks = splitForTelegram(content)
        for (const chunk of chunks) {
            await tgSend(token, chatId, chunk)
        }
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

async function readTaskAssets(taskId: string): Promise<string | null> {
    try {
        const { readdirSync, readFileSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')
        const dir = `/tmp/plexo-assets/${taskId}`
        if (!existsSync(dir)) return null
        const files = readdirSync(dir).filter(f => /\.(txt|md|json|csv|html)$/i.test(f))
        if (files.length === 0) return null
        const contents = files.map(f => readFileSync(join(dir, f), 'utf-8')).join('\n\n---\n\n')
        return contents.length > 0 ? contents : null
    } catch {
        return null
    }
}

function splitForTelegram(text: string): string[] {
    if (text.length <= TG_MAX_LEN) return [text]
    const messages: string[] = []
    let remaining = text
    while (remaining.length > 0) {
        if (remaining.length <= TG_MAX_LEN) {
            messages.push(remaining)
            break
        }
        let splitAt = remaining.lastIndexOf('\n', TG_MAX_LEN)
        if (splitAt < TG_MAX_LEN * 0.3) splitAt = TG_MAX_LEN
        messages.push(remaining.slice(0, splitAt))
        remaining = remaining.slice(splitAt)
    }
    return messages
}
