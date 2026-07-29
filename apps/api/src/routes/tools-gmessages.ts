// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tools API — Google Messages convenience surface.
 *
 * Higher-level endpoints used by app integrations (e.g. Levio) to invoke
 * gmessages without first resolving channelId/pairedSessionId.
 *
 * GET  /api/v1/tools/gmessages/threads?workspaceId&phoneE164?&limit?
 *   Returns recent gmessages threads across all gmessages channels in the
 *   workspace. Optional `phoneE164` filters by participant phone (best-effort
 *   substring match against stored channelRef metadata + sessionId).
 *
 * POST /api/v1/tools/gmessages/send  { workspaceId, threadId?, phoneE164?, text }
 *   Routes to the active paired_session for the workspace. `threadId` is the
 *   primary key — if only `phoneE164` is provided and no existing thread maps
 *   to it, returns 501 (Phase 1 requires an existing thread; new-recipient
 *   send needs sidecar StartConversation work).
 */

import { Router, type Router as RouterType } from 'express'
import * as toolsGmessagesRepo from '../repositories/tools-gmessages.repository.js'
import { ulid } from 'ulid'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { sidecarSessionSend } from '../lib/gmessages-sidecar.js'

export const toolsGmessagesRouter: RouterType = Router()

// Service-key gated: app integrations (Levio, Fylo, Nexalog) hit these
// endpoints directly with Bearer PLEXO_SERVICE_KEY + X-App-Id. Mirrors the
// auth posture of /api/v1/graph/*.
toolsGmessagesRouter.use(requireServiceKey)

type Participant = { phone?: string; name?: string }

interface ThreadOut {
    threadId: string
    participants: Participant[]
    lastMessage: {
        text: string
        direction: 'inbound' | 'outbound'
        sentAt: string
        hasAttachment?: boolean
    }
    unreadCount: number
}

function participantsFromChannelRef(channelRef: unknown): Participant[] {
    if (!channelRef || typeof channelRef !== 'object') return []
    const ref = channelRef as { chatId?: unknown; participants?: unknown }
    if (Array.isArray(ref.participants)) {
        return (ref.participants as Participant[]).filter(p => p && typeof p === 'object')
    }
    const chatId = typeof ref.chatId === 'string' ? ref.chatId : null
    if (chatId && /^\+?\d{8,}$/.test(chatId)) {
        return [{ phone: chatId.startsWith('+') ? chatId : `+${chatId}` }]
    }
    return []
}

toolsGmessagesRouter.get('/threads', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined
    const phoneE164 = req.query.phoneE164 as string | undefined
    const limitRaw = req.query.limit as string | undefined
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '20', 10) || 20, 1), 100)

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const gmChannels = await toolsGmessagesRepo.listGmessagesChannelIds(workspaceId)

        if (gmChannels.length === 0) {
            res.json({ threads: [] })
            return
        }
        const channelIds = gmChannels.map(c => c.id)

        const rows = await toolsGmessagesRepo.listGmessagesThreadRows(workspaceId, channelIds)

        const seen = new Set<string>()
        const out: ThreadOut[] = []
        for (const r of rows) {
            const ref = r.channelRef as { chatId?: string } | null
            const threadId = ref?.chatId ?? r.sessionId?.replace(/^gmessages:/, '') ?? null
            if (!threadId) continue
            if (seen.has(threadId)) continue
            seen.add(threadId)

            const participants = participantsFromChannelRef(r.channelRef)
            if (phoneE164) {
                const norm = phoneE164.replace(/[^\d+]/g, '')
                const matchesPhone = participants.some(p =>
                    typeof p.phone === 'string'
                    && p.phone.replace(/[^\d+]/g, '').endsWith(norm.replace(/^\+/, '')),
                )
                if (!matchesPhone) continue
            }

            const isOutbound = !!(r.reply && r.reply.length > 0) && !(r.message && r.message.length > 0)
            const text = isOutbound ? r.reply! : (r.message ?? '')
            const attachments = Array.isArray(r.attachments) ? r.attachments : []
            out.push({
                threadId,
                participants,
                lastMessage: {
                    text: text.slice(0, 280),
                    direction: isOutbound ? 'outbound' : 'inbound',
                    sentAt: r.createdAt.toISOString(),
                    hasAttachment: attachments.length > 0,
                },
                unreadCount: 0,
            })
            if (out.length >= limit) break
        }
        res.json({ threads: out })
    } catch (err) {
        logger.error({ err }, 'GET /tools/gmessages/threads failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list threads' } })
    }
})

toolsGmessagesRouter.post('/send', async (req, res) => {
    const { workspaceId, threadId, phoneE164, text } = req.body as {
        workspaceId?: string
        threadId?: string
        phoneE164?: string
        text?: string
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'workspaceId required' } })
        return
    }
    if (typeof text !== 'string' || !text.length) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'text required' } })
        return
    }
    if (!threadId && !phoneE164) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'threadId or phoneE164 required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const row = await toolsGmessagesRepo.getLiveSession(workspaceId)

        if (!row) {
            res.status(409).json({ error: { code: 'SESSION_NOT_LIVE', message: 'No live gmessages session for this workspace' } })
            return
        }

        let resolvedThreadId = threadId
        if (!resolvedThreadId && phoneE164) {
            const norm = phoneE164.replace(/[^\d+]/g, '')
            const recentRows = await toolsGmessagesRepo.listRecentGmessagesChannelRefs(workspaceId)
            for (const r of recentRows) {
                const ref = r.channelRef as { chatId?: string } | null
                const chatId = ref?.chatId
                if (chatId && chatId.replace(/[^\d+]/g, '').endsWith(norm.replace(/^\+/, ''))) {
                    resolvedThreadId = chatId
                    break
                }
            }
            if (!resolvedThreadId) {
                res.status(501).json({ error: { code: 'PHONE_LOOKUP_NOT_IMPLEMENTED', message: 'No existing thread for this phone. Start the conversation from the Google Messages app first.' } })
                return
            }
        }

        const idempotencyKey = ulid()
        const sentAt = new Date()
        const finalThreadId = resolvedThreadId!
        try {
            await sidecarSessionSend(row.sessionId, finalThreadId, text, idempotencyKey)
        } catch (err) {
            logger.error({ err, channelId: row.channelId, threadId: finalThreadId, pairedSessionId: row.sessionId }, 'tools.gmessages.send sidecar failed')
            res.status(502).json({ error: { code: 'SIDECAR_SEND_FAILED', message: 'Sidecar dispatch failed' } })
            return
        }

        const conversationId = ulid()
        try {
            await toolsGmessagesRepo.insertConversation({
                id: conversationId,
                workspaceId,
                sessionId: `gmessages:${finalThreadId}`,
                source: 'gmessages',
                message: '',
                reply: text,
                status: 'complete',
                intent: null,
                channelRef: { channel: 'gmessages', channelId: row.channelId, chatId: finalThreadId },
                attachments: [],
                createdAt: sentAt,
            })
        } catch (err) {
            logger.warn({ err, channelId: row.channelId, threadId: finalThreadId }, 'tools.gmessages.send conversation insert failed')
        }

        res.status(202).json({
            messageId: conversationId,
            deliveryStatus: 'pending',
        })
    } catch (err) {
        logger.error({ err }, 'POST /tools/gmessages/send failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to send message' } })
    }
})
