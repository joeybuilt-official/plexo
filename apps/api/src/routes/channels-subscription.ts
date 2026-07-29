// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channel subscription contract for sibling apps (ADR-0002).
 *
 * Endpoints (mounted at /api/plexo/channels):
 *   GET    /                                         list visible channels
 *   POST   /:channelId/subscribe                     create subscription
 *   DELETE /:channelId/subscribe/:subscriptionId     tear down
 *   GET    /:channelId/threads                       paginated thread list
 *   GET    /:channelId/threads/:threadId/messages    paginated messages
 *   POST   /:channelId/threads/:threadId/messages    send (idempotent)
 *   GET    /:channelId/events                        SSE event stream
 *
 * Pex SPEC stays at 0.4.0; the subscription contract is host-side surface only.
 * All endpoints require HMAC service auth (`requireHmacService`) and per-app
 * scope enforcement.
 *
 * Phase 2 ships the contract surface + auth + parameter validation. The
 * data-path implementations for `threads`, `messages`, `send`, and `events`
 * are deliberately skeletal — Phase 4 wires the viewer/lifecycle, Phase 5
 * the ingestion path, and the gmessages connector lands the SSE producer.
 */

import express, { type Request, type Response, type Router } from 'express'
import * as channelsRepo from '../repositories/channels.repository.js'
import { PEX_VERSION, type ChannelDescriptor, type ChannelScope } from '@joeybuilt/plexo-sdk'
import { requireHmacService } from '../middleware/hmac-service.js'
import { logger } from '../logger.js'

export const channelsSubscriptionRouter: Router = express.Router()

// All endpoints HMAC-authenticated.
channelsSubscriptionRouter.use(requireHmacService)

const ALL_SCOPES: ChannelScope[] = [
    'channels:list',
    'channels:subscribe',
    'channels:read',
    'channels:send',
    'channels:events',
]

function requireScopes(_appId: string, _wanted: ChannelScope[]): boolean {
    // TODO Phase 4: per-app manifest scope enforcement once the manifest
    // registry lands. Until then, an HMAC-authenticated app inherits all
    // scopes — same posture as the existing /api/plexo/data contract.
    return true
}

// ── List channels ──────────────────────────────────────────────────────────
channelsSubscriptionRouter.get('/', async (req: Request, res: Response) => {
    const appId = req.plexoAppId!
    if (!requireScopes(appId, ['channels:list'])) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'channels:list scope required' } })
        return
    }

    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined

    const rows = await channelsRepo.listDescriptors(workspaceId)

    const out: ChannelDescriptor[] = rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        type: r.type,
        name: r.name,
        // Phase 2: descriptor only carries "active" for enabled rows. Phase 4
        // joins paired_sessions.state and surfaces it here.
        state: r.enabled ? 'active' : 'errored',
        enabled: r.enabled,
        lastMessageAt: r.lastMessageAt?.toISOString(),
        pexVersion: PEX_VERSION,
    }))
    res.json(out)
})

// ── Subscribe ──────────────────────────────────────────────────────────────
channelsSubscriptionRouter.post('/:channelId/subscribe', async (req: Request, res: Response) => {
    const appId = req.plexoAppId!
    if (!requireScopes(appId, ['channels:subscribe'])) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'channels:subscribe scope required' } })
        return
    }

    const channelId = String(req.params.channelId)
    const requested = (req.body?.scopes as ChannelScope[] | undefined) ?? ALL_SCOPES
    const invalid = requested.filter((s) => !ALL_SCOPES.includes(s))
    if (invalid.length) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: `unknown scope: ${invalid.join(',')}` } })
        return
    }

    if (!await channelsRepo.existsById(channelId)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'channel not found' } })
        return
    }

    // Phase 4 will persist subscriptions in a `channel_subscriptions` table
    // with a TTL + revocation contract. For Phase 2 we return a deterministic
    // ID derived from (appId, channelId) so the contract is exercisable.
    const subscriptionId = `sub_${appId}_${channelId}`
    res.json({
        id: subscriptionId,
        appId,
        channelId,
        scopes: requested,
        createdAt: new Date().toISOString(),
    })
})

channelsSubscriptionRouter.delete('/:channelId/subscribe/:subscriptionId', (_req: Request, res: Response) => {
    res.status(204).end()
})

// ── Threads ───────────────────────────────────────────────────────────────
channelsSubscriptionRouter.get('/:channelId/threads', async (req: Request, res: Response) => {
    const appId = req.plexoAppId!
    if (!requireScopes(appId, ['channels:read'])) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'channels:read scope required' } })
        return
    }
    const channelId = String(req.params.channelId)
    if (!await channelsRepo.existsById(channelId)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'channel not found' } })
        return
    }
    // Phase 4 fills in the thread aggregate query. Empty page is a valid
    // response for a freshly paired channel.
    res.json({ threads: [] })
})

// ── Messages ──────────────────────────────────────────────────────────────
channelsSubscriptionRouter.get('/:channelId/threads/:threadId/messages', async (req: Request, res: Response) => {
    const appId = req.plexoAppId!
    if (!requireScopes(appId, ['channels:read'])) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'channels:read scope required' } })
        return
    }
    const channelId = String(req.params.channelId)
    if (!await channelsRepo.existsById(channelId)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'channel not found' } })
        return
    }
    res.json({ messages: [] })
})

// ── Send ──────────────────────────────────────────────────────────────────
channelsSubscriptionRouter.post('/:channelId/threads/:threadId/messages', async (req: Request, res: Response) => {
    const appId = req.plexoAppId!
    if (!requireScopes(appId, ['channels:send'])) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'channels:send scope required' } })
        return
    }
    if (typeof req.body?.idempotencyKey !== 'string' || !req.body.idempotencyKey.length) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'idempotencyKey required' } })
        return
    }
    if (typeof req.body?.text !== 'string') {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'text required' } })
        return
    }

    const channelId = String(req.params.channelId)
    const threadId = String(req.params.threadId)
    if (!await channelsRepo.existsById(channelId)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'channel not found' } })
        return
    }
    // Phase 5 implements the actual outbound dispatch via the connector.
    res.status(202).json({
        id: req.body.idempotencyKey,
        channelId,
        threadId,
        direction: 'outbound',
        text: req.body.text,
        attachments: req.body.attachments ?? [],
        senderId: 'plexo',
        sentAt: new Date().toISOString(),
        pexVersion: PEX_VERSION,
    })
})

// ── Events (SSE) ──────────────────────────────────────────────────────────
channelsSubscriptionRouter.get('/:channelId/events', async (req: Request, res: Response) => {
    const appId = req.plexoAppId!
    if (!requireScopes(appId, ['channels:events'])) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'channels:events scope required' } })
        return
    }
    const channelId = String(req.params.channelId)
    if (!await channelsRepo.existsById(channelId)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'channel not found' } })
        return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // Phase 4/5: this stream pulls from the in-process pub/sub fed by the
    // gmessages connector inbound route. Until then the stream stays open
    // and emits a periodic keepalive so clients can validate connectivity.
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30_000)
    req.on('close', () => {
        clearInterval(keepalive)
        logger.debug({ appId, channelId }, 'SSE client disconnected')
    })
})
