// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connector-facing inbound route for the Google Messages Go sidecar.
 *
 * Mounted at /api/plexo/channels/gmessages. HMAC-authenticated; the sidecar
 * posts one event per inbound libgmessages event (ADR-0001 §3, ADR-0004
 * "Event ordering + backpressure"). Phase 5 lands the message normalization
 * pipeline (libgmessages event → ChannelMessage → ingestion → memory).
 *
 * Phase 2 ships the contract surface so the Go skeleton in Phase 3 can wire
 * its outbound HTTP client against a real endpoint.
 */

import express, { type Request, type Response, type Router } from 'express'
import * as channelsGmessagesRepo from '../repositories/channels-gmessages.repository.js'
import * as channelsRepo from '../repositories/channels.repository.js'
import { ulid } from 'ulid'
import { requireHmacService } from '../middleware/hmac-service.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const channelsGmessagesRouter: Router = express.Router()

channelsGmessagesRouter.use(requireHmacService)

// ── Restore list — sidecar boot rehydration (ADR-0004 §"Restart semantics") ─
//
// Returns one entry per paired session in state IN ('paired','active','refreshing'),
// each carrying the encrypted AuthData blob from installed_connections.
// Decryption happens INSIDE the sidecar — Plexo API never returns plaintext
// libgm credentials. The sidecar reads ENCRYPTION_SECRET via its
// GMESSAGES_MASTER_KEY env and reproduces the workspace-keyed AES-256-GCM
// derivation that crypto.ts performed at pair time.
//
// `'paired'` is included so any row stranded by the historical Phase 4a
// gap (state never advanced past `'paired'`) rehydrates on the next
// sidecar restart instead of requiring a manual psql UPDATE.
channelsGmessagesRouter.get('/restore-list', async (_req: Request, res: Response) => {
    try {
        const rows = await channelsGmessagesRepo.listRestoreEntries()

        const entries = rows.map(r => {
            const creds = r.credentials as { encrypted?: string } | null
            return {
                pairedSessionId: r.pairedSessionId,
                workspaceId: r.workspaceId,
                channelId: r.channelId,
                encryptedAuthBlob: creds?.encrypted ?? '',
            }
        }).filter(e => e.encryptedAuthBlob.length > 0)

        res.status(200).json({ entries })
    } catch (err) {
        logger.error({ err }, 'gmessages restore-list failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'restore-list failed' } })
    }
})

// ── Inbound message envelope from the sidecar ─────────────────────────────
//
// Phase 5: validates the frozen envelope, dedupes against
// plexo_gmessages.message_dedupe (PK on workspace_id + gmessages_msg_id),
// and persists into the canonical `conversations` table on first sight.
//
// Out of scope here (Phase 6+): attachment fetch/decrypt/re-upload (the
// envelope's attachment.url is currently the libgm CDN URL; we record it
// verbatim), reflectAndPromote memory pipeline integration, SSE fan-out
// (the keepalive stub at /api/plexo/channels/:channelId/events stays
// untouched).
channelsGmessagesRouter.post('/inbound', async (req: Request, res: Response) => {
    try {
        const body = req.body ?? {}
        const {
            workspaceId,
            channelId,
            threadId,
            gmessagesMsgId,
            text,
            sentAt,
            senderId,
            attachments,
        } = body as {
            workspaceId?: unknown
            channelId?: unknown
            threadId?: unknown
            gmessagesMsgId?: unknown
            text?: unknown
            sentAt?: unknown
            senderId?: unknown
            attachments?: unknown
        }

        if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)
            || typeof channelId !== 'string' || !UUID_RE.test(channelId)
            || typeof threadId !== 'string' || threadId.length === 0
            || typeof gmessagesMsgId !== 'string' || gmessagesMsgId.length === 0
            || typeof text !== 'string'
            || typeof sentAt !== 'string' || sentAt.length === 0) {
            res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'missing or invalid inbound fields' } })
            return
        }

        const sentAtDate = new Date(sentAt)
        if (Number.isNaN(sentAtDate.getTime())) {
            res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'sentAt must be RFC3339' } })
            return
        }

        // Channel must exist + belong to the workspace + be a gmessages channel.
        const channel = await channelsRepo.getEnabledScoped(channelId, workspaceId)
        if (!channel || channel.type !== 'gmessages') {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'channel not found or not gmessages' } })
            return
        }

        // Dedupe via PK (workspace_id, gmessages_msg_id). RETURNING is empty on
        // conflict — that's the signal the message was already ingested.
        const dedupeRows = await channelsGmessagesRepo.insertDedupe(workspaceId, gmessagesMsgId, threadId)

        if (dedupeRows.length === 0) {
            logger.info({ workspaceId, channelId, threadId, gmessagesMsgId }, 'gmessages inbound deduped')
            res.status(202).json({ accepted: true, deduped: true })
            return
        }

        // Normalize attachments: envelope uses { url, mimeType, filename? } —
        // map mimeType → type to fit the conversations.attachments schema
        // (which is shared with telegram and uses `type` for legacy reasons).
        const inAtts = Array.isArray(attachments) ? attachments : []
        const normalizedAtts: { url: string; type: string; filename?: string }[] = []
        for (const a of inAtts) {
            if (a && typeof a === 'object') {
                const rec = a as { url?: unknown; mimeType?: unknown; filename?: unknown }
                if (typeof rec.url === 'string' && rec.url.length > 0) {
                    const att: { url: string; type: string; filename?: string } = {
                        url: rec.url,
                        type: typeof rec.mimeType === 'string' && rec.mimeType.length > 0
                            ? rec.mimeType
                            : 'application/octet-stream',
                    }
                    if (typeof rec.filename === 'string' && rec.filename.length > 0) {
                        att.filename = rec.filename
                    }
                    normalizedAtts.push(att)
                }
            }
        }

        const conversationId = ulid()
        await channelsGmessagesRepo.insertConversation({
            id: conversationId,
            workspaceId,
            sessionId: `gmessages:${threadId}`,
            source: 'gmessages',
            message: text,
            reply: null,
            status: 'complete',
            intent: null,
            channelRef: { channel: 'gmessages', channelId, chatId: threadId },
            attachments: normalizedAtts,
            createdAt: sentAtDate,
        })

        // Best-effort lastMessageAt bump. senderId is logged but not yet
        // persisted (no senderId column on conversations); Phase 6 ops can
        // join on a future contacts table if needed.
        try {
            await channelsGmessagesRepo.bumpLastMessageAt(channelId, sentAtDate)
        } catch (err) {
            logger.warn({ err, channelId }, 'gmessages inbound: lastMessageAt update failed')
        }

        logger.info({ workspaceId, channelId, threadId, gmessagesMsgId, conversationId, senderId }, 'gmessages inbound accepted')
        res.status(202).json({ accepted: true, deduped: false, conversationId })
    } catch (err) {
        logger.error({ err }, 'gmessages inbound failed')
        res.status(500).json({ error: { code: 'INTERNAL', message: 'inbound failed' } })
    }
})

// ── Connection state change emitted by the sidecar ────────────────────────
channelsGmessagesRouter.post('/state', async (req: Request, res: Response) => {
    const { pairedSessionId, state, errorDetail } = req.body ?? {}
    if (!pairedSessionId || !state) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'pairedSessionId+state required' } })
        return
    }

    const allowed = ['paired', 'active', 'refreshing', 'expired', 'revoked', 'errored'] as const
    if (!allowed.includes(state)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: `invalid state: ${state}` } })
        return
    }

    await channelsGmessagesRepo.updateSessionState(pairedSessionId, state, errorDetail ?? null)

    res.status(202).json({ accepted: true })
})

// ── Flow heartbeat (ADR-0004 — last-inbound + decode-error counter) ───────
channelsGmessagesRouter.post('/heartbeat', async (req: Request, res: Response) => {
    const { pairedSessionId, lastInboundAt, decodeErrorCount } = req.body ?? {}
    if (!pairedSessionId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'pairedSessionId required' } })
        return
    }

    await channelsGmessagesRepo.updateSessionHeartbeat(
        pairedSessionId,
        lastInboundAt ? new Date(lastInboundAt) : undefined,
        typeof decodeErrorCount === 'number' ? decodeErrorCount : undefined,
    )

    res.status(204).end()
})
