// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * conversation-log.ts
 *
 * Shared utility for recording conversation turns and routing replies
 * back to originating channels (Telegram, Slack, etc.).
 *
 * Used by:
 *   - apps/api/src/routes/chat.ts      (web chat)
 *   - apps/api/src/routes/telegram.ts  (Telegram adapter)
 *   - apps/api/src/routes/slack.ts     (Slack adapter)
 *   - apps/api/src/routes/discord.ts   (Discord adapter)
 */

import { db, eq, desc, sql } from '@plexo/db'
import { conversations } from '@plexo/db'
import { ulid } from 'ulid'
import { logger } from './logger.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChannelRef {
    channel: 'telegram' | 'slack' | 'discord' | string
    channelId: string
    chatId: string
}

export interface RecordConversationParams {
    workspaceId: string
    sessionId?: string | null
    source: string
    message: string
    reply?: string | null
    errorMsg?: string | null
    status: 'complete' | 'failed' | 'pending'
    intent?: string | null
    taskId?: string | null
    channelRef?: ChannelRef | null
}

// ── Record a single conversation turn ─────────────────────────────────────────

export async function recordConversation(params: RecordConversationParams): Promise<string> {
    const id = ulid()
    await db.insert(conversations).values({
        id,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId ?? null,
        source: params.source,
        message: params.message,
        reply: params.reply ?? null,
        errorMsg: params.errorMsg ?? null,
        status: params.status,
        intent: params.intent ?? null,
        taskId: params.taskId ?? null,
        channelRef: params.channelRef ?? null,
    })
    return id
}

// ── Update conversation with a resolved taskId ────────────────────────────────

export async function linkTaskToConversation(conversationId: string, taskId: string): Promise<void> {
    await db.update(conversations)
        .set({ taskId })
        .where(eq(conversations.id, conversationId))
}

// ── Look up channelRef for a session ─────────────────────────────────────────

export async function getSessionChannelRef(
    workspaceId: string,
    sessionId: string,
): Promise<ChannelRef | null> {
    const [row] = await db
        .select({ channelRef: conversations.channelRef })
        .from(conversations)
        .where(sql`workspace_id = ${workspaceId} AND session_id = ${sessionId} AND channel_ref IS NOT NULL`)
        .orderBy(desc(conversations.createdAt))
        .limit(1)
    return (row?.channelRef as ChannelRef | null) ?? null
}

// ── Fetch all turns for a session ─────────────────────────────────────────────

export async function getSessionTurns(
    workspaceId: string,
    sessionId: string,
    limit = 50,
) {
    const rows = await db
        .select()
        .from(conversations)
        .where(sql`workspace_id = ${workspaceId} AND session_id = ${sessionId}`)
        .orderBy(desc(conversations.createdAt))
        .limit(limit)
    
    // Reverse so the oldest of the most recent 50 is first (chronological order)
    return rows.reverse()
}

// ── Reply back to an originating channel ──────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org/bot'

/**
 * Send a reply back to the channel that originated a conversation.
 * Called from chat.ts when a web message is sent in a session that came from an external channel.
 * Non-fatal — failure is logged but does not break the web response.
 */
export async function replyToChannel(
    channelRef: ChannelRef,
    text: string,
    channelToken?: string,
): Promise<void> {
    if (channelRef.channel === 'telegram') {
        if (!channelToken) {
            logger.warn({ channelRef }, 'replyToChannel: no token available for Telegram channel')
            return
        }
        try {
            await fetch(`${TELEGRAM_API}${channelToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: channelRef.chatId,
                    text: `💬 *From Plexo web:*\n${text}`,
                    parse_mode: 'Markdown',
                }),
                signal: AbortSignal.timeout(10_000),
            })
        } catch (err) {
            logger.warn({ err, channelRef }, 'replyToChannel: Telegram sendMessage failed')
        }
    }
    // TODO: Slack and Discord adapters can be added here following the same pattern
}
