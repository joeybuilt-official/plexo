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

// ── Session gap configuration ─────────────────────────────────────────────────

/**
 * How long the user can be silent before the next incoming message is treated
 * as a fresh conversation session. Configurable via SESSION_TIMEOUT_MINUTES;
 * defaults to 30 minutes.
 */
export const SESSION_TIMEOUT_MINUTES = (() => {
    const raw = process.env.SESSION_TIMEOUT_MINUTES
    const n = raw ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) && n > 0 ? n : 30
})()
export const SESSION_TIMEOUT_MS = SESSION_TIMEOUT_MINUTES * 60_000

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
    attachments?: { url: string; type: string; alt?: string; filename?: string; sizeBytes?: number; contentHash?: string; scanStatus?: 'unscanned' | 'clean' | 'infected' | 'error' }[] | null
    /**
     * Embedding of `message` — stored on the row and folded into the running
     * session topic embedding so future turns can compare. Optional; callers
     * typically get this from the session resolver.
     */
    messageEmbedding?: number[] | null
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
        attachments: params.attachments ?? [],
        sessionEmbedding: params.messageEmbedding ?? null,
    })

    // Fold the new message embedding into the session's running topic embedding.
    // Non-fatal and fire-and-forget — sessions still work if this fails.
    if (params.messageEmbedding && params.sessionId) {
        void (async () => {
            try {
                const mod = await import('./lib/session-resolver.js')
                await mod.persistTurnEmbedding({
                    conversationId: id,
                    workspaceId: params.workspaceId,
                    sessionId: params.sessionId!,
                    newMessageEmbedding: params.messageEmbedding!,
                })
            } catch (err) {
                logger.debug({ err }, 'recordConversation: persistTurnEmbedding failed (non-fatal)')
            }
        })()
    }

    return id
}

// ── Update conversation with a resolved taskId ────────────────────────────────

export async function linkTaskToConversation(conversationId: string, taskId: string): Promise<void> {
    await db.update(conversations)
        .set({ taskId })
        .where(eq(conversations.id, conversationId))
}

// ── Update a conversation linked to a completed/failed task ──────────────────

/**
 * Backfill the reply + status on a conversation row that was inserted at task
 * creation time with status='pending' and no reply. Called from agent-loop
 * when the task finishes (success or failure).
 */
export async function updateConversationForTask(
    taskId: string,
    update: { reply?: string | null; errorMsg?: string | null; status: 'complete' | 'failed' },
): Promise<void> {
    await db.update(conversations)
        .set({
            reply: update.reply ?? null,
            errorMsg: update.errorMsg ?? null,
            status: update.status,
        })
        .where(eq(conversations.taskId, taskId))
}

// ── Mark a conversation as failed delivery ───────────────────────────────────

export async function markConversationDeliveryFailed(conversationId: string, errorMsg: string): Promise<void> {
    await db.update(conversations)
        .set({ status: 'failed', errorMsg })
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

// ── Gap-based session ID resolution ───────────────────────────────────────────

/**
 * Resolve the current session ID for an external-channel chat, using the
 * `conversations` table as the source of truth.
 *
 * Rules:
 *  - Find the most recent conversation row for this workspace/source/channelId/chatId.
 *  - If the last message is within SESSION_TIMEOUT_MS → reuse its session_id.
 *  - Otherwise → mint a new session_id of shape `<source>:<channelId>:<chatId>:<ulid>`.
 *
 * This replaces the old in-memory session counter, which reset on every server
 * restart and caused all messages to collapse into a single session ID.
 *
 * Non-fatal: on DB failure we fall back to minting a fresh ID so the caller
 * never blocks on this helper.
 */
export async function resolveChannelSessionId(opts: {
    workspaceId: string
    source: 'telegram' | 'slack' | 'discord' | string
    channelId: string
    chatId: string
    /** Optional extra discriminator (e.g. Slack thread_ts) folded into the key. */
    threadKey?: string
    now?: number
}): Promise<string> {
    const now = opts.now ?? Date.now()
    const suffix = opts.threadKey ? `:${opts.threadKey}` : ''
    const keyPrefix = `${opts.source}:${opts.channelId}:${opts.chatId}${suffix}`

    try {
        const [row] = await db
            .select({ sessionId: conversations.sessionId, createdAt: conversations.createdAt })
            .from(conversations)
            .where(sql`
                workspace_id = ${opts.workspaceId}
                AND source = ${opts.source}
                AND session_id LIKE ${keyPrefix + ':%'}
            `)
            .orderBy(desc(conversations.createdAt))
            .limit(1)

        if (row?.sessionId && row.createdAt) {
            const last = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt as unknown as string).getTime()
            if (Number.isFinite(last) && now - last <= SESSION_TIMEOUT_MS) {
                return row.sessionId
            }
        }
    } catch (err) {
        logger.warn({ err, source: opts.source, channelId: opts.channelId, chatId: opts.chatId }, 'resolveChannelSessionId: DB lookup failed — minting fresh id')
    }

    return `${keyPrefix}:${ulid()}`
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

// ── Cross-session history (all channels) ─────────────────────────────────────

type SessionKey =
    | { kind: 'web_base'; clientId: string }      // session-<ts> bypass — exact match
    | { kind: 'web_prefixed'; clientId: string }  // web:clientId:ulid — LIKE + exact
    | { kind: 'channel'; prefix: string }          // telegram/slack/discord prefix LIKE

function extractSessionKey(sessionId: string): SessionKey | null {
    // Webchat client-minted bypass: session-<timestamp>
    if (sessionId.startsWith('session-')) {
        return { kind: 'web_base', clientId: sessionId }
    }
    // Webchat resolver-minted: web:clientSessionId:ulid
    if (sessionId.startsWith('web:')) {
        const parts = sessionId.split(':')
        const clientId = parts[1] ?? null
        return clientId ? { kind: 'web_prefixed', clientId } : null
    }
    // External channels: source:...:<ulid> — strip ULID suffix to get stable prefix
    const lastColon = sessionId.lastIndexOf(':')
    if (lastColon > 0) {
        const prefix = sessionId.slice(0, lastColon)
        if (prefix.startsWith('telegram:') || prefix.startsWith('slack:') || prefix.startsWith('discord:')) {
            return { kind: 'channel', prefix }
        }
    }
    return null
}

/**
 * Load the most recent turns from prior sessions for the same client/chat.
 * Works for web, Telegram, Slack, and Discord sessions.
 * Returns empty array for unrecognized session formats or on DB failure.
 */
export async function getCrossSessionTurns(
    workspaceId: string,
    sessionId: string,
    limit = 20,
) {
    const key = extractSessionKey(sessionId)
    if (!key) return []
    try {
        const rows = key.kind === 'web_base'
            ? await db.select().from(conversations)
                .where(sql`workspace_id = ${workspaceId} AND session_id = ${key.clientId} AND session_id != ${sessionId}`)
                .orderBy(desc(conversations.createdAt)).limit(limit)
            : key.kind === 'web_prefixed'
            ? await db.select().from(conversations)
                .where(sql`workspace_id = ${workspaceId} AND (session_id = ${key.clientId} OR session_id LIKE ${'web:' + key.clientId + ':%'}) AND session_id != ${sessionId}`)
                .orderBy(desc(conversations.createdAt)).limit(limit)
            : await db.select().from(conversations)
                .where(sql`workspace_id = ${workspaceId} AND session_id LIKE ${key.prefix + ':%'} AND session_id != ${sessionId}`)
                .orderBy(desc(conversations.createdAt)).limit(limit)
        return rows.reverse()
    } catch (err) {
        logger.warn({ err, workspaceId, sessionId }, 'getCrossSessionTurns: DB lookup failed')
        return []
    }
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
    attachments?: { url: string; type: string; alt?: string; filename?: string; sizeBytes?: number; contentHash?: string; scanStatus?: 'unscanned' | 'clean' | 'infected' | 'error' }[] | null,
): Promise<void> {
    if (channelRef.channel === 'telegram') {
        if (!channelToken) {
            logger.warn({ channelRef }, 'replyToChannel: no token available for Telegram channel')
            return
        }
        try {
            const hasImages = (attachments ?? []).some(a => a.type === 'image' || a.url.match(/\.(png|jpg|jpeg|gif|webp)$/i))
            
            if (hasImages) {
                // Send as photos. For now, we take the first image or send all as individual photos.
                // Telegram supports media groups, but for simplicity we'll send the text + first image.
                const firstImg = (attachments ?? []).find(a => a.type === 'image' || a.url.match(/\.(png|jpg|jpeg|gif|webp)$/i))
                if (firstImg) {
                    await fetch(`${TELEGRAM_API}${channelToken}/sendPhoto`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: channelRef.chatId,
                            photo: firstImg.url,
                            caption: `💬 *From Plexo web:*\n${text}`,
                            parse_mode: 'Markdown',
                        }),
                        signal: AbortSignal.timeout(15_000),
                    })
                    return
                }
            }

            // Default to sendMessage
            const msgRes = await fetch(`${TELEGRAM_API}${channelToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: channelRef.chatId,
                    text: `💬 *From Plexo web:*\n${text}`,
                    parse_mode: 'Markdown',
                }),
                signal: AbortSignal.timeout(10_000),
            })
            if (!msgRes.ok) {
                const body = await msgRes.text().catch(() => '')
                logger.error({ status: msgRes.status, body, channelRef }, 'replyToChannel: Telegram HTTP error')
                // Retry without Markdown if parse error
                if (msgRes.status === 400 && body.includes('parse')) {
                    await fetch(`${TELEGRAM_API}${channelToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: channelRef.chatId, text }),
                        signal: AbortSignal.timeout(10_000),
                    })
                }
            }
        } catch (err) {
            logger.error({ err, channelRef }, 'replyToChannel: Telegram sendMessage/sendPhoto failed')
        }
    }
    // FUN-021: Slack relay
    if (channelRef.channel === 'slack') {
        const token = channelToken ?? process.env.SLACK_BOT_TOKEN
        if (!token) {
            logger.warn({ channelRef }, 'replyToChannel: no token available for Slack channel')
            return
        }
        try {
            const res = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    channel: channelRef.chatId,
                    text: `💬 *From Plexo web:*\n${text}`,
                }),
                signal: AbortSignal.timeout(10_000),
            })
            if (!res.ok) {
                const body = await res.text().catch(() => '')
                logger.error({ status: res.status, body, channelRef }, 'replyToChannel: Slack HTTP error')
            }
        } catch (err) {
            logger.error({ err, channelRef }, 'replyToChannel: Slack postMessage failed')
        }
        return
    }

    // FUN-021: Discord relay
    if (channelRef.channel === 'discord') {
        const token = channelToken ?? process.env.DISCORD_BOT_TOKEN
        if (!token) {
            logger.warn({ channelRef }, 'replyToChannel: no token available for Discord channel')
            return
        }
        try {
            const res = await fetch(`https://discord.com/api/v10/channels/${channelRef.chatId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
                body: JSON.stringify({
                    content: `💬 **From Plexo web:**\n${text}`,
                }),
                signal: AbortSignal.timeout(10_000),
            })
            if (!res.ok) {
                const body = await res.text().catch(() => '')
                logger.error({ status: res.status, body, channelRef }, 'replyToChannel: Discord HTTP error')
            }
        } catch (err) {
            logger.error({ err, channelRef }, 'replyToChannel: Discord send failed')
        }
        return
    }
}
