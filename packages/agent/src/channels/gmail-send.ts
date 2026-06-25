// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Outbound Gmail reply via Gmail API users.messages.send.
 *
 * No googleapis / nodemailer dependency — direct fetch with OAuth2 bearer.
 * Reuses the dual-purpose installed_connections row that powers inbound:
 * the gmail channel row carries config.installedConnectionId pointing at
 * the OAuth credentials encrypted at rest.
 *
 * Threading: pass both threadId (Gmail-native) and the In-Reply-To /
 * References RFC 5322 headers so the reply lands in the same conversation
 * across Gmail, IMAP clients, and Outlook.
 *
 * Reference: https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
 */

import pino from 'pino'
import { buildMime, type BuildMimeAttachment } from './multipart-builder.js'

const logger = pino({ name: 'gmail-send' })

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Per ADR 0013 §D5: 25 MiB pre-encoding cap on outbound payloads.
 * Gmail's documented `raw` limit is 35 MB after base64; 25 MiB binary
 * gives ~33 MB after base64 with header headroom.
 */
const MAX_OUTBOUND_RAW_BYTES = 25 * 1024 * 1024

export interface GmailSendParams {
    /** channels.id — used to look up the dual-purpose installed_connection. */
    channelId: string
    to: string
    subject: string
    body: string
    /** Gmail thread ID for top-level threading. */
    threadId?: string
    /** RFC 5322 Message-ID of the message we're replying to. */
    inReplyTo?: string
    /** Optional outbound attachments per ADR 0013. Bytes already resolved by caller. */
    attachments?: BuildMimeAttachment[]
}

export interface GmailSendResult {
    ok: boolean
    messageId?: string
    threadId?: string
    error?: string
    status?: number
}

interface GmailChannelConfig {
    installedConnectionId?: string
    emailAddress?: string
}

interface OAuthCredentials {
    access_token?: string
    refresh_token?: string
    expires_at?: string
    email?: string
}

function base64url(input: string): string {
    return Buffer.from(input, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

/**
 * Loads the gmail channel row, decrypts its installed_connection credentials,
 * and returns access_token + emailAddress for outbound delivery.
 */
async function loadGmailDelivery(
    channelId: string,
): Promise<{
    workspaceId: string
    connectionId: string
    accessToken: string
    refreshToken: string | null
    expiresAt: string | null
    fromEmail: string
} | null> {
    const { db } = await import('@plexo/db')
    const { eq } = await import('drizzle-orm')
    const { channels, installedConnections } = await import('@plexo/db')

    const [chRow] = await db
        .select({ workspaceId: channels.workspaceId, type: channels.type, enabled: channels.enabled, config: channels.config })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
    if (!chRow || chRow.type !== 'gmail' || !chRow.enabled) {
        logger.warn({ channelId, type: chRow?.type, enabled: chRow?.enabled }, 'Gmail: channel not found or disabled')
        return null
    }

    const cfg = (chRow.config ?? {}) as GmailChannelConfig
    if (!cfg.installedConnectionId) {
        logger.warn({ channelId }, 'Gmail: channel.config.installedConnectionId missing')
        return null
    }

    const [icRow] = await db
        .select({ id: installedConnections.id, credentials: installedConnections.credentials })
        .from(installedConnections)
        .where(eq(installedConnections.id, cfg.installedConnectionId))
        .limit(1)
    if (!icRow) {
        logger.warn({ channelId, installedConnectionId: cfg.installedConnectionId }, 'Gmail: installed_connection not found')
        return null
    }

    const { decrypt } = await import('../connections/crypto-util.js')
    let creds: OAuthCredentials
    try {
        const raw = icRow.credentials as { encrypted?: string } | null
        if (!raw?.encrypted) return null
        creds = JSON.parse(decrypt(raw.encrypted, chRow.workspaceId)) as OAuthCredentials
    } catch (err) {
        logger.warn({ channelId, err: err instanceof Error ? err.message : String(err) }, 'Gmail: credential decrypt failed')
        return null
    }

    if (!creds.access_token) {
        logger.warn({ channelId }, 'Gmail: no access_token in credentials')
        return null
    }

    const fromEmail = cfg.emailAddress ?? creds.email
    if (!fromEmail) {
        logger.warn({ channelId }, 'Gmail: no emailAddress in channel config or credentials')
        return null
    }

    return {
        workspaceId: chRow.workspaceId,
        connectionId: icRow.id,
        accessToken: creds.access_token,
        refreshToken: creds.refresh_token ?? null,
        expiresAt: creds.expires_at ?? null,
        fromEmail,
    }
}

async function refreshAccessToken(
    workspaceId: string,
    connectionId: string,
    refreshToken: string,
): Promise<string | null> {
    const clientId = process.env.GOOGLE_CLIENT_ID
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET
    if (!clientId || !clientSecret) {
        logger.warn({ connectionId }, 'Gmail: GOOGLE_CLIENT_ID/SECRET not set, cannot refresh')
        return null
    }
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
    } catch (err) {
        logger.warn({ connectionId, err: err instanceof Error ? err.message : String(err) }, 'Gmail: token refresh fetch failed')
        return null
    }
    if (!res.ok) {
        logger.warn({ connectionId, status: res.status }, 'Gmail: token refresh returned non-2xx')
        return null
    }
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
    if (!data.access_token) return null

    // Persist the refreshed token back to installed_connections so future calls hit the cache.
    try {
        const { db } = await import('@plexo/db')
        const { eq } = await import('drizzle-orm')
        const { installedConnections } = await import('@plexo/db')
        const { decrypt, encrypt } = await import('../connections/crypto-util.js')
        const [row] = await db
            .select({ credentials: installedConnections.credentials })
            .from(installedConnections)
            .where(eq(installedConnections.id, connectionId))
            .limit(1)
        if (row) {
            const raw = row.credentials as { encrypted?: string } | null
            if (raw?.encrypted) {
                const existing = JSON.parse(decrypt(raw.encrypted, workspaceId)) as OAuthCredentials
                existing.access_token = data.access_token
                existing.expires_at = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString()
                const encrypted = { encrypted: encrypt(JSON.stringify(existing), workspaceId) }
                await db
                    .update(installedConnections)
                    .set({ credentials: encrypted, lastVerifiedAt: new Date() })
                    .where(eq(installedConnections.id, connectionId))
            }
        }
    } catch (err) {
        logger.warn({ connectionId, err: err instanceof Error ? err.message : String(err) }, 'Gmail: token persist after refresh failed (non-fatal)')
    }

    return data.access_token
}

async function postSend(
    accessToken: string,
    raw: string,
    threadId: string | undefined,
): Promise<Response> {
    return fetch(GMAIL_SEND_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
        signal: AbortSignal.timeout(15_000),
    })
}

export async function gmailSend(params: GmailSendParams): Promise<GmailSendResult> {
    const { channelId, to, subject, body, threadId, inReplyTo, attachments } = params
    if (!channelId) return { ok: false, error: 'Missing channelId' }
    if (!to) return { ok: false, error: 'Missing recipient' }
    if (!body || !body.trim()) return { ok: false, error: 'Empty message body' }

    // Pre-flight 25 MiB cap (ADR 0013 §D5): sum body + attachment bytes BEFORE
    // base64 encoding. Gmail's 35 MB raw limit is post-base64; this gives the
    // ~33% inflation headroom plus header overhead room.
    const bodyBytes = Buffer.byteLength(body, 'utf8')
    const attachBytes = (attachments ?? []).reduce((s, a) => s + a.bytes.length, 0)
    if (bodyBytes + attachBytes > MAX_OUTBOUND_RAW_BYTES) {
        return {
            ok: false,
            status: 413,
            error: 'PAYLOAD_TOO_LARGE: total > 25 MiB pre-encoding',
        }
    }

    const delivery = await loadGmailDelivery(channelId)
    if (!delivery) return { ok: false, error: 'Gmail channel/connection unavailable' }

    const mime = buildMime({
        from: delivery.fromEmail,
        to,
        subject,
        bodyText: body,
        inReplyTo,
        attachments,
    })
    const raw = base64url(mime.raw)

    let accessToken = delivery.accessToken
    let res: Response
    try {
        res = await postSend(accessToken, raw, threadId)
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
    }

    // Single retry on auth failure: refresh and re-send.
    if (res.status === 401 && delivery.refreshToken) {
        const refreshed = await refreshAccessToken(delivery.workspaceId, delivery.connectionId, delivery.refreshToken)
        if (!refreshed) {
            return { ok: false, status: 401, error: 'Gmail auth refresh failed' }
        }
        accessToken = refreshed
        try {
            res = await postSend(accessToken, raw, threadId)
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'fetch failed (retry)' }
        }
    }

    if (!res.ok) {
        let detail = `Gmail HTTP ${res.status}`
        try {
            const payload = (await res.json()) as { error?: { message?: string } }
            if (payload?.error?.message) detail = payload.error.message
        } catch { /* non-JSON body */ }
        return { ok: false, status: res.status, error: detail }
    }

    let payload: { id?: string; threadId?: string } = {}
    try { payload = (await res.json()) as typeof payload } catch { /* non-JSON */ }
    return { ok: true, status: res.status, messageId: payload.id, threadId: payload.threadId }
}
