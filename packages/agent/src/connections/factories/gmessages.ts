// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Google Messages tool factory — agent-callable tools backed by the
 * apps/gmessages Go sidecar (ADR-0001).
 *
 * Tools (matches the connections_registry seed in 0117_gmessages_phase2_schema.sql):
 *   - gmessages__send_message — outbound text into a Google Messages thread
 *   - gmessages__list_threads — recent conversation threads for the channel
 *
 * Architecture note: unlike most factories which talk a public API directly,
 * gmessages requires the Go sidecar (it owns the libgm session goroutine and
 * the encrypted libgm AuthData). The factory therefore:
 *   1. Resolves the live paired session for this connection from
 *      `plexo_gmessages.paired_sessions` (the ground truth — `installed_connections`
 *      can have stale rows after revoke; the live session row is what matters).
 *   2. HMAC-POSTs the sidecar's `/sessions/:pairedSessionId/send` endpoint
 *      using the shared PLEXO_SERVICE_KEY. Mirrors apps/api's
 *      lib/gmessages-sidecar.ts wire format byte-for-byte.
 *   3. Persists the optimistic outbound row into `conversations` (so the
 *      web channel viewer + agent's later list_threads call see the send).
 *
 * Credentials passed in are not used here — the encrypted AuthData blob is
 * decrypted by the sidecar at boot, not by Plexo Core (ADR-0003).
 *
 * Required env (sidecar coords — set in platform compose / VPS .env):
 *   - GMESSAGES_SIDECAR_URL   default: http://gmessages:3010
 *   - PLEXO_SERVICE_KEY        shared HMAC secret (same as apps/api uses)
 *
 * Operator setup post-merge:
 *   1. Pair a phone via the web UI: /app/connections/gmessages/pair
 *   2. Once `plexo_gmessages.paired_sessions.state='active'` the agent can
 *      call gmessages__send_message and gmessages__list_threads.
 *   3. If `gmessages__send_message` returns "Sidecar dispatch failed", check
 *      the sidecar container (plexo-gmessages on prod VPS) and
 *      RUNBOOK §4 for HMAC / env mismatch causes.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { createHmac } from 'node:crypto'
import { ulid } from 'ulid'
import pino from 'pino'
import type { ConnectionCredentials, ToolSet } from '../bridge-types.js'

const logger = pino({ name: 'gmessages:tools' })

const APP_ID = 'plexo-api'

function sidecarBaseUrl(): string {
    return (process.env.GMESSAGES_SIDECAR_URL ?? 'http://gmessages:3010').replace(/\/$/, '')
}

function serviceKey(): string {
    const k = process.env.PLEXO_SERVICE_KEY
    if (!k) throw new Error('PLEXO_SERVICE_KEY not set — gmessages sidecar HMAC unavailable')
    return k
}

function sign(body: string): { sig: string; ts: string } {
    const sig = 'sha256=' + createHmac('sha256', serviceKey()).update(body).digest('hex')
    const ts = new Date().toISOString()
    return { sig, ts }
}

interface PairedSessionRow {
    id: string
    channelId: string
    state: string
}

async function findLivePairedSession(
    workspaceId: string,
    connectionId: string,
    threadHintChannelId?: string,
): Promise<PairedSessionRow | null> {
    // Lazy-import @plexo/db so this factory file does not contribute to
    // bridge.ts's circular load. Mirrors the levio.ts pattern.
    const { db, eq, and, inArray, desc, pairedSessions } = await import('@plexo/db')
    const live: ('active' | 'paired' | 'refreshing')[] = ['active', 'paired', 'refreshing']

    const baseWhere = threadHintChannelId
        ? and(
            eq(pairedSessions.workspaceId, workspaceId),
            eq(pairedSessions.installedConnectionId, connectionId),
            eq(pairedSessions.channelId, threadHintChannelId),
            inArray(pairedSessions.state, live),
        )
        : and(
            eq(pairedSessions.workspaceId, workspaceId),
            eq(pairedSessions.installedConnectionId, connectionId),
            inArray(pairedSessions.state, live),
        )

    const [row] = await db
        .select({
            id: pairedSessions.id,
            channelId: pairedSessions.channelId,
            state: pairedSessions.state,
        })
        .from(pairedSessions)
        .where(baseWhere)
        .orderBy(desc(pairedSessions.stateChangedAt))
        .limit(1)
    return row ?? null
}

interface SidecarSendResponse {
    accepted: true
    messageId?: string
}

async function sidecarSend(
    pairedSessionId: string,
    threadId: string,
    text: string,
    idempotencyKey: string,
): Promise<SidecarSendResponse> {
    const body = JSON.stringify({ threadId, text, idempotencyKey })
    const { sig, ts } = sign(body)
    const res = await fetch(
        `${sidecarBaseUrl()}/sessions/${encodeURIComponent(pairedSessionId)}/send`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-App-Id': APP_ID,
                'X-Plexo-Timestamp': ts,
                'X-Plexo-Signature': sig,
            },
            body,
            signal: AbortSignal.timeout(10_000),
        },
    )
    if (!res.ok && res.status !== 202) {
        const t = await res.text().catch(() => '')
        throw new Error(`gmessages sidecar /sessions/${pairedSessionId}/send ${res.status}: ${t}`)
    }
    try {
        return (await res.json()) as SidecarSendResponse
    } catch {
        return { accepted: true }
    }
}

function audit(toolName: string, detail: Record<string, unknown>, opts: { connectionId: string; workspaceId: string }) {
    logger.info({
        type: 'gmessages_tool_call',
        toolName,
        connectionId: opts.connectionId,
        workspaceId: opts.workspaceId,
        ...detail,
    }, `Google Messages tool: ${toolName}`)
}

export const GMESSAGES_TOOLS = (
    _creds: ConnectionCredentials,
    opts: { connectionId: string; workspaceId: string },
): ToolSet => {
    void _creds  // libgm AuthData lives in the sidecar; not used here.

    return {
        gmessages__send_message: tool({
            description:
                'Send a text message via Google Messages (SMS/RCS) through the user\'s paired phone. ' +
                'Use this to reply to or initiate a Google Messages conversation. ' +
                'Requires a previously-paired phone — if no live session exists the tool returns a clear error and the user must visit /app/connections/gmessages/pair.',
            inputSchema: z.object({
                threadId: z.string().describe('Google Messages thread ID. Get this from gmessages__list_threads.'),
                text: z.string().min(1).max(4096).describe('Message body. Plain text only; no markdown.'),
            }),
            execute: async ({ threadId, text }) => {
                try {
                    const session = await findLivePairedSession(opts.workspaceId, opts.connectionId)
                    if (!session) {
                        return 'Google Messages error: no live paired session for this connection. Pair a phone at /app/connections/gmessages/pair before sending.'
                    }

                    const idempotencyKey = ulid()
                    const sentAt = new Date()

                    let resp: SidecarSendResponse
                    try {
                        resp = await sidecarSend(session.id, threadId, text, idempotencyKey)
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err)
                        logger.error({ err: msg, channelId: session.channelId, threadId, pairedSessionId: session.id }, 'gmessages tool send failed')
                        return `Google Messages send failed (sidecar dispatch error): ${msg}. Check that the apps/gmessages sidecar container is running and PLEXO_SERVICE_KEY matches between plexo-api and the sidecar.`
                    }

                    // Persist optimistic outbound row mirroring apps/api channels.ts POST handler.
                    try {
                        const { db, conversations } = await import('@plexo/db')
                        await db.insert(conversations).values({
                            id: ulid(),
                            workspaceId: opts.workspaceId,
                            sessionId: `gmessages:${threadId}`,
                            source: 'gmessages',
                            message: '',
                            reply: text,
                            status: 'complete',
                            intent: null,
                            channelRef: { channel: 'gmessages', channelId: session.channelId, chatId: threadId },
                            attachments: [],
                            createdAt: sentAt,
                        })
                    } catch (err) {
                        // Non-fatal — the message was already dispatched to the phone.
                        logger.warn({ err, threadId }, 'gmessages tool: outbound conversation insert failed (send still dispatched)')
                    }

                    audit('gmessages__send_message', { threadId, pairedSessionId: session.id, messageId: resp.messageId }, opts)
                    return `Sent to thread ${threadId}${resp.messageId ? ` (id ${resp.messageId})` : ''}.`
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    return `Google Messages send_message failed: ${msg}`
                }
            },
        }),

        gmessages__list_threads: tool({
            description:
                'List recent Google Messages conversation threads for the paired phone, most-recent first. ' +
                'Each thread row carries its threadId (use as input to gmessages__send_message), a short preview of the last message, and the timestamp.',
            inputSchema: z.object({
                limit: z.number().int().min(1).max(100).optional().default(25).describe('Max number of threads to return.'),
            }),
            execute: async ({ limit }) => {
                try {
                    const session = await findLivePairedSession(opts.workspaceId, opts.connectionId)
                    if (!session) {
                        return 'Google Messages error: no live paired session for this connection. Pair a phone at /app/connections/gmessages/pair to begin.'
                    }

                    const { db, eq, and, desc, sql, conversations } = await import('@plexo/db')
                    // Same fold logic as apps/api channels.ts GET /:id/threads,
                    // narrowed to this paired session's channel.
                    const rows = await db
                        .select({
                            sessionId: conversations.sessionId,
                            message: conversations.message,
                            reply: conversations.reply,
                            createdAt: conversations.createdAt,
                            channelRef: conversations.channelRef,
                        })
                        .from(conversations)
                        .where(and(
                            eq(conversations.workspaceId, opts.workspaceId),
                            eq(conversations.source, 'gmessages'),
                            sql`${conversations.sessionId} IS NOT NULL`,
                            sql`${conversations.channelRef}->>'channelId' = ${session.channelId}`,
                        ))
                        .orderBy(desc(conversations.createdAt))
                        .limit(2000)

                    const seen = new Set<string>()
                    type ThreadOut = { threadId: string; preview: string; lastMessageAt: string }
                    const threads: ThreadOut[] = []
                    for (const r of rows) {
                        if (!r.sessionId) continue
                        if (seen.has(r.sessionId)) continue
                        seen.add(r.sessionId)
                        const ref = r.channelRef as { chatId?: string } | null
                        const threadId = ref?.chatId ?? r.sessionId.replace(/^gmessages:/, '')
                        const preview = (r.reply && r.reply.length > 0 ? r.reply : r.message).slice(0, 200)
                        threads.push({
                            threadId,
                            preview,
                            lastMessageAt: r.createdAt.toISOString(),
                        })
                        if (threads.length >= limit) break
                    }

                    audit('gmessages__list_threads', { count: threads.length, channelId: session.channelId }, opts)
                    if (threads.length === 0) {
                        return 'No Google Messages threads yet. Once messages arrive on the paired phone they will appear here.'
                    }
                    return threads
                        .map(t => `[${t.lastMessageAt}] ${t.threadId}\n  ${t.preview}`)
                        .join('\n')
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    return `Google Messages list_threads failed: ${msg}`
                }
            },
        }),
    }
}
