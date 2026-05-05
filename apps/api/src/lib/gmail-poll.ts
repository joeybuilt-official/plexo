// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Gmail-as-channel inbound poller.
 *
 * Architecture (L3 Decision A — dual-purpose connection):
 * - A row in `channels` (type='gmail') references an `installed_connections`
 *   row via `config.installedConnectionId`. The connection's encrypted OAuth
 *   credentials are reused for both agent-tool calls and channel polling —
 *   no duplicate credential storage.
 * - Runs every minute via the in-process cron scheduler (cron.ts INTERNAL_JOBS).
 *   A 0-30s jitter is applied at the cron site to spread load when many
 *   workspaces have channels.
 * - Per channel: read lastHistoryId from config → call Gmail history.list →
 *   for each new messageId, fetch full message → dedup → persist conversation
 *   + push task → advance lastHistoryId atomically once the cycle succeeds.
 *
 * Mirrors the Twilio inbound flow at routes/twilio.ts (signature-verify is
 * N/A since polling is server-initiated, not webhook-driven).
 */

import { db, and, eq, sql } from '@plexo/db'
import { channels, installedConnections } from '@plexo/db'
import { push as pushTask } from '@plexo/queue'
import { decrypt, encrypt } from '../crypto.js'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { recordConversation, type ChannelRef } from '../conversation-log.js'
import { fetchGmailProfile } from './gmail-client.js'

// ── Inbound messageId dedup (5-min TTL) ─────────────────────────────────────

const SEEN_MESSAGE_IDS = new Map<string, number>()
const DEDUP_TTL_MS = 5 * 60_000

function alreadySeen(messageId: string): boolean {
    const now = Date.now()
    if (SEEN_MESSAGE_IDS.size > 5000) {
        for (const [id, expiresAt] of SEEN_MESSAGE_IDS) {
            if (expiresAt < now) SEEN_MESSAGE_IDS.delete(id)
        }
    }
    const expiresAt = SEEN_MESSAGE_IDS.get(messageId)
    if (expiresAt && expiresAt > now) return true
    SEEN_MESSAGE_IDS.set(messageId, now + DEDUP_TTL_MS)
    return false
}

/** Test hook — clears dedup map between cases. */
export function _resetGmailDedupForTests(): void {
    SEEN_MESSAGE_IDS.clear()
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface GmailChannelConfig {
    installedConnectionId: string
    lastHistoryId?: string
    [key: string]: unknown
}

interface DecryptedCreds {
    access_token?: string
    refresh_token?: string
    expires_at?: string | null
    [key: string]: unknown
}

interface GmailHeader { name: string; value: string }
interface GmailMessagePart {
    mimeType?: string
    body?: { data?: string; size?: number }
    parts?: GmailMessagePart[]
}
interface GmailMessage {
    id: string
    threadId?: string
    snippet?: string
    historyId?: string
    payload?: {
        headers?: GmailHeader[]
        body?: { data?: string }
        parts?: GmailMessagePart[]
        mimeType?: string
    }
}
interface GmailHistoryEntry {
    id: string
    messages?: Array<{ id: string; threadId?: string }>
    messagesAdded?: Array<{ message: { id: string; threadId?: string; labelIds?: string[] } }>
}
interface GmailHistoryResponse {
    history?: GmailHistoryEntry[]
    historyId?: string
    nextPageToken?: string
}

interface ChannelRow {
    id: string
    workspaceId: string
    config: unknown
    enabled: boolean
}

// ── Dependency injection seam (for tests) ────────────────────────────────────

/** Outcome of a refresh-token call. Distinguishes recoverable failures
 *  (network/5xx — keep connection healthy, just track the channel error)
 *  from real OAuth revocation (invalid_grant — flip the connection status). */
export type RefreshResult =
    | { kind: 'success'; access_token: string; expires_at: string }
    | { kind: 'invalid_grant' }   // OAuth refresh token revoked — disable connection
    | { kind: 'transient' }        // 5xx / network — channel-only error

export interface PollDeps {
    listGmailChannels(): Promise<ChannelRow[]>
    loadConnection(connectionId: string, workspaceId: string): Promise<DecryptedCreds | null>
    persistRefreshedCreds(connectionId: string, workspaceId: string, creds: DecryptedCreds): Promise<void>
    /** Increment per-channel error counter; does NOT touch installed_connections.status. */
    markChannelErrored(channelId: string, message: string): Promise<void>
    /** Flip installed_connections.status='error'. Reserved for genuine OAuth revoke (invalid_grant). */
    markConnectionRevoked(connectionId: string, reason: string): Promise<void>
    fetchHistory(accessToken: string, startHistoryId: string, pageToken?: string): Promise<{ status: number; data?: GmailHistoryResponse; error?: string }>
    fetchMessage(accessToken: string, messageId: string): Promise<{ status: number; data?: GmailMessage; error?: string }>
    refreshAccessToken(refreshToken: string): Promise<RefreshResult>
    /** Inline baseline (Fix 5): when channel has no lastHistoryId, fetch the
     *  current historyId so the next cycle can list real history.
     *  Returns null on failure (caller will increment channel errorCount). */
    baselineHistoryId(connectionId: string, workspaceId: string): Promise<string | null>
    updateLastHistoryId(channelId: string, historyId: string): Promise<void>
    persistInbound(args: {
        workspaceId: string
        channelId: string
        threadId: string
        messageId: string
        from: string
        subject: string
        bodyText: string
        attachments?: import('./gmail-attachments.js').AttachmentMeta[]
    }): Promise<void>
    /** Phase N — fetch a single attachment's bytes via Gmail API. */
    fetchAttachment?(accessToken: string, messageId: string, attachmentId: string): Promise<{
        status: number
        bytes?: Buffer
        error?: string
    }>
    /** Phase N — upload attachment bytes to object storage and return the canonical URL. */
    uploadAttachment?(args: {
        workspaceId: string
        contentHash: string
        filename: string
        mimeType: string
        bytes: Buffer
    }): Promise<{ url: string }>
}

/** Safety belt: cap history pagination to avoid runaway loops on malformed
 *  responses or attack accounts emitting >5000 events/min. */
const MAX_HISTORY_PAGES = 50

// ── Body extraction (text/plain preferred, HTML fallback) ────────────────────

const MAX_BODY_BYTES = 32 * 1024

function decodeBase64Url(data: string): string {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function stripHtml(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
}

function findPart(part: GmailMessagePart | undefined, mime: string): GmailMessagePart | null {
    if (!part) return null
    if (part.mimeType === mime && part.body?.data) return part
    if (part.parts) {
        for (const child of part.parts) {
            const hit = findPart(child, mime)
            if (hit) return hit
        }
    }
    return null
}

export function extractBodyText(msg: GmailMessage): string {
    const payload = msg.payload
    if (!payload) return msg.snippet ?? ''

    const plain = findPart(payload as GmailMessagePart, 'text/plain')
    if (plain?.body?.data) {
        const text = decodeBase64Url(plain.body.data)
        return text.slice(0, MAX_BODY_BYTES)
    }

    const html = findPart(payload as GmailMessagePart, 'text/html')
    if (html?.body?.data) {
        const decoded = decodeBase64Url(html.body.data)
        return stripHtml(decoded).slice(0, MAX_BODY_BYTES)
    }

    if (payload.body?.data) {
        const decoded = decodeBase64Url(payload.body.data)
        const text = payload.mimeType === 'text/html' ? stripHtml(decoded) : decoded
        return text.slice(0, MAX_BODY_BYTES)
    }

    return (msg.snippet ?? '').slice(0, MAX_BODY_BYTES)
}

export function extractHeader(msg: GmailMessage, name: string): string {
    const hdrs = msg.payload?.headers ?? []
    return hdrs.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// ── Default deps (real implementations) ──────────────────────────────────────

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

const defaultDeps: PollDeps = {
    async listGmailChannels() {
        const rows = await db
            .select({ id: channels.id, workspaceId: channels.workspaceId, config: channels.config, enabled: channels.enabled })
            .from(channels)
            .where(eq(channels.type, 'gmail'))
        return rows.filter((r) => r.enabled) as ChannelRow[]
    },

    async loadConnection(connectionId, workspaceId) {
        // Defense-in-depth: filter by workspaceId in SQL even though the
        // workspace-scoped AES key would already make cross-workspace
        // decrypt fail. Belt + suspenders.
        const [row] = await db
            .select({ credentials: installedConnections.credentials, status: installedConnections.status })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.id, connectionId),
                eq(installedConnections.workspaceId, workspaceId),
            ))
            .limit(1)
        if (!row) return null
        const raw = row.credentials as Record<string, unknown> | null
        if (!raw?.encrypted) return null
        try {
            const decrypted = decrypt(raw.encrypted as string, workspaceId)
            return JSON.parse(decrypted) as DecryptedCreds
        } catch (err) {
            logger.warn({ err, connectionId }, 'gmail-poll: failed to decrypt credentials')
            return null
        }
    },

    async persistRefreshedCreds(connectionId, workspaceId, creds) {
        const encrypted = { encrypted: encrypt(JSON.stringify(creds), workspaceId) }
        await db.update(installedConnections)
            .set({ credentials: encrypted, lastVerifiedAt: new Date() })
            .where(eq(installedConnections.id, connectionId))
    },

    async markChannelErrored(channelId, message) {
        await db.update(channels)
            .set({
                errorCount: sql`error_count + 1`,
                lastError: message.slice(0, 500),
                lastErrorAt: new Date(),
            })
            .where(eq(channels.id, channelId))
    },

    async markConnectionRevoked(connectionId, reason) {
        await db.update(installedConnections)
            .set({ status: 'error', errorDetail: reason.slice(0, 500) })
            .where(eq(installedConnections.id, connectionId))
    },

    async fetchHistory(accessToken, startHistoryId, pageToken) {
        let url = `${GMAIL_BASE}/users/me/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded`
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
            return { status: res.status, error: (await res.text()).slice(0, 300) }
        }
        return { status: res.status, data: await res.json() as GmailHistoryResponse }
    },

    async fetchMessage(accessToken, messageId) {
        const url = `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(messageId)}?format=full`
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
            return { status: res.status, error: (await res.text()).slice(0, 300) }
        }
        return { status: res.status, data: await res.json() as GmailMessage }
    },

    async fetchAttachment(accessToken, messageId, attachmentId) {
        const url = `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) {
            return { status: res.status, error: (await res.text()).slice(0, 300) }
        }
        const data = await res.json() as { data?: string; size?: number }
        if (!data.data) return { status: res.status, error: 'no data field' }
        const { decodeBase64url } = await import('./gmail-attachments.js')
        return { status: res.status, bytes: decodeBase64url(data.data) }
    },

    async uploadAttachment({ workspaceId, contentHash, filename, mimeType, bytes }) {
        const { uploadToKey } = await import('@plexo/storage')
        const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
        const key = `attachments/${workspaceId}/${contentHash}-${safeFilename}`
        const result = await uploadToKey({ key, content: bytes, contentType: mimeType })
        return { url: result.url }
    },

    async refreshAccessToken(refreshToken) {
        const clientId = process.env.GOOGLE_CLIENT_ID
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET
        if (!clientId || !clientSecret) return { kind: 'transient' }
        let res: Response
        try {
            res = await fetch(GOOGLE_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: clientId,
                    client_secret: clientSecret,
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token',
                }),
                signal: AbortSignal.timeout(10_000),
            })
        } catch {
            return { kind: 'transient' }
        }
        if (!res.ok) {
            // 4xx with invalid_grant body == revoked refresh token. Anything else
            // (5xx, network) is transient.
            if (res.status >= 400 && res.status < 500) {
                try {
                    const body = await res.text()
                    if (body.includes('invalid_grant')) return { kind: 'invalid_grant' }
                } catch { /* fall through */ }
            }
            return { kind: 'transient' }
        }
        const data = await res.json() as { access_token?: string; expires_in?: number }
        if (!data.access_token) return { kind: 'transient' }
        return {
            kind: 'success',
            access_token: data.access_token,
            expires_at: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
        }
    },

    async baselineHistoryId(connectionId, workspaceId) {
        const profile = await fetchGmailProfile(connectionId, workspaceId)
        return profile?.historyId ?? null
    },

    async updateLastHistoryId(channelId, historyId) {
        await db.execute(sql`
            UPDATE channels
            SET config = jsonb_set(config, '{lastHistoryId}', ${`"${historyId}"`}::jsonb),
                last_message_at = NOW()
            WHERE id = ${channelId}
        `)
    },

    async persistInbound({ workspaceId, channelId, threadId, messageId, from, subject, bodyText, attachments }) {
        const channelRef: ChannelRef = { channel: 'gmail', channelId, chatId: from }
        let taskId: string | null = null
        try {
            taskId = await pushTask({
                workspaceId,
                type: 'automation',
                source: 'gmail',
                context: {
                    description: bodyText,
                    channel: 'gmail',
                    chatId: from,
                    channelId,
                    from,
                    threadId,
                    messageId,
                    subject,
                    channelRef,
                },
                priority: 2,
            })
            trackEvent('channel.task_created', 'info', { channel: 'gmail', taskId, workspaceId })
        } catch (err) {
            logger.error({ err, channelId, workspaceId }, 'gmail-poll: pushTask failed')
            trackEvent('channel.error', 'error', { channel: 'gmail', error: 'task_queue_failed' })
        }

        await recordConversation({
            workspaceId,
            sessionId: `gmail:${channelId}:${threadId}`,
            source: 'gmail',
            message: bodyText,
            status: taskId ? 'complete' : 'failed',
            intent: 'TASK',
            taskId,
            channelRef,
            attachments: attachments && attachments.length > 0 ? attachments : null,
        }).catch((err: Error) => logger.warn({ err }, 'gmail-poll: recordConversation failed'))
    },
}

// ── Per-channel poll ─────────────────────────────────────────────────────────

/** Outcome marker used internally to keep error attribution tidy. */
type RefreshOutcome =
    | { ok: true; creds: DecryptedCreds }
    | { ok: false; revoked: boolean; reason: string }

async function withFreshToken(
    creds: DecryptedCreds,
    deps: PollDeps,
    connectionId: string,
    workspaceId: string,
): Promise<RefreshOutcome> {
    if (!creds.access_token) return { ok: false, revoked: false, reason: 'no access_token' }
    const expiresAt = creds.expires_at ? new Date(creds.expires_at).getTime() : 0
    if (expiresAt && expiresAt > Date.now() + 60_000) return { ok: true, creds }
    if (!creds.refresh_token) return { ok: true, creds } // can't refresh — try existing token

    const refreshed = await deps.refreshAccessToken(creds.refresh_token)
    if (refreshed.kind === 'invalid_grant') {
        return { ok: false, revoked: true, reason: 'oauth refresh token revoked (invalid_grant)' }
    }
    if (refreshed.kind === 'transient') {
        return { ok: false, revoked: false, reason: 'token refresh transient failure' }
    }
    const updated: DecryptedCreds = {
        ...creds,
        access_token: refreshed.access_token,
        expires_at: refreshed.expires_at,
    }
    await deps.persistRefreshedCreds(connectionId, workspaceId, updated)
    return { ok: true, creds: updated }
}

async function pollOneChannel(channel: ChannelRow, deps: PollDeps): Promise<void> {
    const cfg = (channel.config ?? {}) as GmailChannelConfig
    const connectionId = cfg.installedConnectionId
    if (!connectionId) {
        logger.warn({ channelId: channel.id }, 'gmail-poll: channel.config.installedConnectionId missing')
        await deps.markChannelErrored(channel.id, 'config.installedConnectionId missing')
        return
    }

    let creds = await deps.loadConnection(connectionId, channel.workspaceId)
    if (!creds || !creds.access_token) {
        logger.warn({ channelId: channel.id, connectionId }, 'gmail-poll: connection not found / no access_token')
        await deps.markChannelErrored(channel.id, 'connection not found or missing access_token')
        return
    }

    const fresh = await withFreshToken(creds, deps, connectionId, channel.workspaceId)
    if (!fresh.ok) {
        if (fresh.revoked) {
            await deps.markConnectionRevoked(connectionId, fresh.reason)
        }
        await deps.markChannelErrored(channel.id, fresh.reason)
        return
    }
    creds = fresh.creds

    const startHistoryId = cfg.lastHistoryId
    if (!startHistoryId) {
        // Inline baseline (Fix 5): if a channel has no lastHistoryId (e.g. the
        // post-create baseline call failed), seed it now. Next cycle will
        // fetch real history. If the baseline call itself fails, increment
        // the channel's error counter so we surface the issue rather than
        // silently looping.
        const baseline = await deps.baselineHistoryId(connectionId, channel.workspaceId)
        if (!baseline) {
            await deps.markChannelErrored(channel.id, 'baseline historyId fetch failed')
            return
        }
        await deps.updateLastHistoryId(channel.id, baseline)
        return
    }

    // Pagination loop (Fix 1): the Gmail history API can return up to 100
    // entries per page. If a workspace receives a burst, ignoring the
    // nextPageToken would silently drop the tail. Walk the cursor until we
    // exhaust pages (or the safety belt fires).
    const aggregatedNewMessages: Array<{ id: string; threadId?: string }> = []
    const seenInThisCycle = new Set<string>()
    let lastResponseHistoryId: string | undefined
    let pageToken: string | undefined
    let pageCount = 0
    let didRefreshOn401 = false

    while (true) {
        if (pageCount >= MAX_HISTORY_PAGES) {
            logger.warn({ channelId: channel.id, pageCount }, 'gmail-poll: history pagination cap hit — deferring remainder to next cycle')
            break
        }
        pageCount++

        let history = await deps.fetchHistory(creds.access_token!, startHistoryId, pageToken)
        if (history.status === 401) {
            if (didRefreshOn401) {
                // Already refreshed once during this cycle — a second 401 means
                // the new token is also rejected. Treat as transient channel error.
                await deps.markChannelErrored(channel.id, 'persistent 401 after refresh')
                return
            }
            if (!creds.refresh_token) {
                await deps.markChannelErrored(channel.id, 'access token rejected, no refresh_token')
                return
            }
            const refreshed = await deps.refreshAccessToken(creds.refresh_token)
            if (refreshed.kind === 'invalid_grant') {
                await deps.markConnectionRevoked(connectionId, 'oauth refresh token revoked (invalid_grant after 401)')
                await deps.markChannelErrored(channel.id, 'oauth refresh token revoked')
                return
            }
            if (refreshed.kind === 'transient') {
                await deps.markChannelErrored(channel.id, 'refresh after 401 failed')
                return
            }
            creds = { ...creds, access_token: refreshed.access_token, expires_at: refreshed.expires_at }
            await deps.persistRefreshedCreds(connectionId, channel.workspaceId, creds)
            didRefreshOn401 = true
            // Retry this page with the new token.
            history = await deps.fetchHistory(creds.access_token!, startHistoryId, pageToken)
            if (history.status === 401) {
                await deps.markChannelErrored(channel.id, 'persistent 401 after refresh')
                return
            }
        }
        if (history.status === 404) {
            // startHistoryId expired (>7 days). Reset to current and skip this cycle.
            logger.warn({ channelId: channel.id }, 'gmail-poll: history id expired — channel must be re-seeded')
            await deps.markChannelErrored(channel.id, 'history id expired (>7d) — must re-seed')
            return
        }
        if (history.status >= 400 || !history.data) {
            logger.warn({ channelId: channel.id, status: history.status, error: history.error }, 'gmail-poll: history fetch failed')
            await deps.markChannelErrored(channel.id, `history fetch failed: ${history.status} ${history.error ?? ''}`.trim())
            return
        }

        for (const entry of history.data.history ?? []) {
            for (const added of entry.messagesAdded ?? []) {
                const m = added.message
                if (m.labelIds && m.labelIds.includes('SENT') && !m.labelIds.includes('INBOX')) continue
                if (seenInThisCycle.has(m.id)) continue
                seenInThisCycle.add(m.id)
                aggregatedNewMessages.push({ id: m.id, threadId: m.threadId })
            }
            for (const m of entry.messages ?? []) {
                if (seenInThisCycle.has(m.id)) continue
                seenInThisCycle.add(m.id)
                aggregatedNewMessages.push(m)
            }
        }

        // Track the response's historyId — only the LAST page's historyId is
        // the watermark we advance to. Earlier pages report intermediate values
        // but Gmail guarantees the final page reflects the latest cursor.
        if (history.data.historyId) lastResponseHistoryId = history.data.historyId

        if (!history.data.nextPageToken) break
        pageToken = history.data.nextPageToken
    }

    for (const { id: messageId } of aggregatedNewMessages) {
        if (alreadySeen(messageId)) continue
        const msgRes = await deps.fetchMessage(creds.access_token!, messageId)
        if (msgRes.status >= 400 || !msgRes.data) {
            logger.warn({ channelId: channel.id, messageId, status: msgRes.status }, 'gmail-poll: message fetch failed')
            continue
        }
        const msg = msgRes.data
        const from = extractHeader(msg, 'From')
        const subject = extractHeader(msg, 'Subject')
        const bodyText = extractBodyText(msg)
        const threadId = msg.threadId ?? messageId

        // Phase N (ADR 0009) — extract + store attachments before persisting the
        // conversation row so the metadata travels with the row's first write.
        let attachments: import('./gmail-attachments.js').AttachmentMeta[] = []
        if (deps.fetchAttachment && deps.uploadAttachment) {
            try {
                const { extractAndStoreAttachments } = await import('./gmail-attachments.js')
                attachments = await extractAndStoreAttachments({
                    msg: { id: messageId, payload: msg.payload as import('./gmail-attachments.js').GmailMessagePart },
                    accessToken: creds.access_token!,
                    workspaceId: channel.workspaceId,
                    channelId: channel.id,
                    deps: { fetchAttachment: deps.fetchAttachment!, uploadAttachment: deps.uploadAttachment! },
                })
            } catch (err) {
                logger.warn({ err, messageId, channelId: channel.id }, 'gmail-poll: attachment extraction failed; proceeding with text-only')
            }
        }

        // Allow attachment-only messages through (e.g., a forwarded photo).
        if (!bodyText.trim() && attachments.length === 0) continue

        await deps.persistInbound({
            workspaceId: channel.workspaceId,
            channelId: channel.id,
            threadId,
            messageId,
            from,
            subject,
            bodyText: bodyText.trim() || `(attachment-only message: ${attachments.length} file(s))`,
            attachments,
        })
    }

    // Advance lastHistoryId only after a successful cycle.
    if (lastResponseHistoryId && lastResponseHistoryId !== startHistoryId) {
        await deps.updateLastHistoryId(channel.id, lastResponseHistoryId)
        logger.debug(
            { channelId: channel.id, fromHistoryId: startHistoryId, toHistoryId: lastResponseHistoryId },
            'gmail-poll: advanced lastHistoryId',
        )
    }
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function pollAllGmailChannels(deps: PollDeps = defaultDeps): Promise<void> {
    let rows: ChannelRow[]
    try {
        rows = await deps.listGmailChannels()
    } catch (err) {
        logger.error({ err }, 'gmail-poll: listGmailChannels failed')
        return
    }
    if (rows.length === 0) return

    for (const channel of rows) {
        try {
            await pollOneChannel(channel, deps)
        } catch (err) {
            logger.error({ err, channelId: channel.id, workspaceId: channel.workspaceId }, 'gmail-poll: per-channel failure (continuing)')
            trackEvent('channel.error', 'error', { channel: 'gmail', error: 'poll_failed', channelId: channel.id })
            const msg = err instanceof Error ? err.message : String(err)
            await deps.markChannelErrored(channel.id, `unhandled poll error: ${msg}`).catch(() => { /* swallow */ })
        }
    }
}
