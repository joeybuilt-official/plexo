// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Twilio SMS channel adapter.
 *
 * Architecture:
 * - Per-channel webhook: POST /api/v1/channels/twilio/events/:channelId
 * - Workspace + auth_token resolved by joining channels row on :channelId
 * - HMAC-SHA1 signature over fullUrl + sorted-form-params (X-Twilio-Signature)
 * - Inbound MessageSid is dedup'd in-memory (5-min TTL) to swallow Twilio retries
 * - Acknowledged with 200 OK + empty TwiML; outbound replies go via the agent
 *   loop calling sendTwilioSms() with credentials from channels.config
 *
 * channels.config shape:
 *   { accountSid: string, authToken: string, fromNumber: string }
 *
 * Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { db, eq } from '@plexo/db'
import { channels } from '@plexo/db'
import { push as pushTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { recordConversation, type ChannelRef } from '../conversation-log.js'
import { resolveSessionId } from '../lib/session-resolver.js'
import { verifyTwilioSignature } from '../lib/twilio-signature.js'

export const twilioRouter: RouterType = Router()

// ── Inbound MessageSid dedup (5-min TTL, Redis-backed with in-memory fallback) ─

const SEEN_MESSAGE_SIDS = new Map<string, number>()
const DEDUP_TTL_MS = 5 * 60_000
const DEDUP_TTL_S = 5 * 60

async function alreadySeen(messageSid: string): Promise<boolean> {
    try {
        const { getRedis, isRedisAvailable } = await import('../redis-client.js')
        if (isRedisAvailable()) {
            const redis = await getRedis()
            const key = `twilio:dedup:${messageSid}`
            const reply = await redis.set(key, '1', { NX: true, EX: DEDUP_TTL_S })
            return reply === null
        }
    } catch {
        // Fall through to in-memory fallback
    }
    const now = Date.now()
    if (SEEN_MESSAGE_SIDS.size > 5000) {
        for (const [sid, expiresAt] of SEEN_MESSAGE_SIDS) {
            if (expiresAt < now) SEEN_MESSAGE_SIDS.delete(sid)
        }
    }
    const expiresAt = SEEN_MESSAGE_SIDS.get(messageSid)
    if (expiresAt && expiresAt > now) return true
    SEEN_MESSAGE_SIDS.set(messageSid, now + DEDUP_TTL_MS)
    return false
}

/** Test hook — allows the dedup map to be cleared between test cases. */
export async function _resetTwilioDedupForTests(): Promise<void> {
    SEEN_MESSAGE_SIDS.clear()
    try {
        const { getRedis, isRedisAvailable } = await import('../redis-client.js')
        if (isRedisAvailable()) {
            const redis = await getRedis()
            const keys = await redis.keys('twilio:dedup:*')
            if (keys.length > 0) await redis.del(keys)
        }
    } catch { /* ignore */ }
}

// ── URL reconstruction ───────────────────────────────────────────────────────

function reconstructFullUrl(req: Request): string {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https'
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || ''
    return `${proto}://${host}${req.originalUrl}`
}

// ── Twilio config from channels.config ───────────────────────────────────────

interface TwilioChannelConfig {
    accountSid?: string
    authToken?: string
    fromNumber?: string
}

// ── Inbound types ─────────────────────────────────────────────────────────────

interface TwilioInboundParams {
    From?: string
    To?: string
    Body?: string
    MessageSid?: string
    AccountSid?: string
    [k: string]: string | undefined
}

// ── POST /api/v1/channels/twilio/events/:channelId ───────────────────────────

twilioRouter.post('/events/:channelId', async (req: Request, res: Response) => {
    const channelIdRaw = req.params.channelId
    const channelId = typeof channelIdRaw === 'string' ? channelIdRaw : Array.isArray(channelIdRaw) ? channelIdRaw[0] : ''
    if (!channelId) {
        res.status(400).json({ error: { code: 'MISSING_CHANNEL_ID', message: 'channelId required' } })
        return
    }

    // Twilio sends application/x-www-form-urlencoded; the app-wide urlencoded
    // parser populates req.body. Anything else is a malformed inbound.
    const rawBody = req.body as Record<string, unknown> | undefined
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Form-urlencoded body required' } })
        return
    }
    const params: TwilioInboundParams = {}
    for (const [k, v] of Object.entries(rawBody)) {
        if (typeof v === 'string') params[k] = v
    }

    if (!params.MessageSid || !params.From || !params.To) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Missing MessageSid / From / To' } })
        return
    }

    // Look up the channel row to resolve workspace + auth token
    let channelRow: { id: string; workspaceId: string; type: string; config: unknown; enabled: boolean } | undefined
    try {
        const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
        channelRow = row as typeof channelRow
    } catch (err) {
        logger.error({ err, channelId }, 'Twilio: channel lookup failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Channel lookup failed' } })
        return
    }
    if (!channelRow || channelRow.type !== 'twilio') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Twilio channel not found' } })
        return
    }
    if (!channelRow.enabled) {
        res.status(410).json({ error: { code: 'CHANNEL_DISABLED', message: 'Channel is disabled' } })
        return
    }

    const { decryptSensitiveConfigKeys } = await import('../lib/channel-config-crypto.js')
    const cfg = decryptSensitiveConfigKeys('twilio', (channelRow.config ?? {}) as Record<string, unknown>, channelRow.workspaceId) as TwilioChannelConfig
    if (!cfg.authToken) {
        logger.error({ channelId }, 'Twilio: channel.config.authToken missing')
        res.status(500).json({ error: { code: 'CHANNEL_MISCONFIGURED', message: 'authToken not set' } })
        return
    }

    // Verify signature
    const signature = (req.headers['x-twilio-signature'] as string) || ''
    const fullUrl = reconstructFullUrl(req)
    const paramsForSig: Record<string, string> = {}
    for (const [k, v] of Object.entries(params)) if (typeof v === 'string') paramsForSig[k] = v
    if (!verifyTwilioSignature(fullUrl, paramsForSig, signature, cfg.authToken)) {
        logger.warn({ channelId }, 'Twilio: signature verification failed')
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } })
        return
    }

    // Replay dedup: respond 200 OK with no double-push.
    if (await alreadySeen(params.MessageSid)) {
        res.status(200).type('text/xml').send('<Response/>')
        return
    }

    const workspaceId = channelRow.workspaceId
    const from = params.From
    const text = (params.Body ?? '').trim()
    if (!text) {
        // Silent ACK for empty bodies (MMS without text, etc.)
        res.status(200).type('text/xml').send('<Response/>')
        return
    }

    // Resolve session
    let sessionId = `twilio:${channelId}:${from}:${Date.now()}`
    let messageEmbedding: number[] | null = null
    try {
        const r = await resolveSessionId({
            workspaceId,
            channel: 'twilio',
            channelThreadId: `${channelId}:${from}`,
            userId: from,
            newMessage: text,
        })
        sessionId = r.sessionId
        messageEmbedding = r.newMessageEmbedding
    } catch (err) {
        logger.warn({ err, channelId, from }, 'Twilio: session resolver failed, using fallback id')
    }

    const channelRef: ChannelRef = {
        channel: 'twilio',
        channelId,
        chatId: from,
    }

    let taskId: string | null = null
    let reply = "On it. I'll text you back when done."
    let status: 'complete' | 'failed' = 'complete'
    let errorMsg: string | null = null
    try {
        taskId = await pushTask({
            workspaceId,
            type: 'automation',
            source: 'twilio',
            context: {
                description: text,
                channel: 'twilio',
                chatId: from,
                channelId,
                from,
                to: params.To,
                messageSid: params.MessageSid,
                channelRef,
            },
            priority: 2,
        })
        trackEvent('channel.task_created', 'info', { channel: 'twilio', taskId, workspaceId, sessionId })
    } catch (err) {
        logger.error({ err, channelId, workspaceId }, 'Twilio: pushTask failed')
        trackEvent('channel.error', 'error', { channel: 'twilio', error: 'task_queue_failed' })
        const reason = err instanceof Error ? err.message.slice(0, 80) : 'Unknown error'
        reply = `Task queue failed — ${reason}.`
        status = 'failed'
        errorMsg = 'Task queue failed'
    }

    await recordConversation({
        workspaceId,
        sessionId,
        source: 'twilio',
        message: text,
        reply,
        status,
        errorMsg,
        intent: 'TASK',
        taskId,
        channelRef,
        messageEmbedding,
    }).catch((err: Error) => logger.warn({ err }, 'Twilio: recordConversation failed'))

    // Empty TwiML — the actual reply is sent via the outbound dispatch
    // (channel-delivery → sendTwilioSms) once the task completes.
    res.status(200).type('text/xml').send('<Response/>')
})

// ── GET /api/v1/channels/twilio/info ─────────────────────────────────────────

twilioRouter.get('/info', (_req, res) => {
    res.json({ channel: 'twilio', dedupCacheSize: SEEN_MESSAGE_SIDS.size })
})
