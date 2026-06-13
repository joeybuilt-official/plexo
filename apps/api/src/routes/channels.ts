// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channels CRUD API
 *
 * GET  /api/channels?workspaceId=     List channels for workspace
 * POST /api/channels                  Create channel
 * PATCH /api/channels/:id             Update (toggle enabled, update config)
 * DELETE /api/channels/:id            Delete channel
 */
import { Router, type Router as RouterType } from 'express'
import type { pairedSessions, conversations } from '@plexo/db'
import { ulid } from 'ulid'
import * as channelsRepo from '../repositories/channels.repository.js'
import { logger } from '../logger.js'
import { registerTelegramChannel } from './telegram.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { fetchGmailProfile } from '../lib/gmail-client.js'
import { filterChannelConfigForPatch } from '../lib/channel-config-allowlist.js'
import { encryptSensitiveConfigKeys } from '../lib/channel-config-crypto.js'
import { sidecarSessionSend } from '../lib/gmessages-sidecar.js'

type PairedSessionState = (typeof pairedSessions.$inferSelect)['state']

/**
 * Fold per-channel paired_sessions rows down to the most-recent one and
 * return a `Map<channelId, state>`. Used by the viewer list + detail
 * endpoints to surface the offline banner sourced from
 * `paired_sessions.state` (ADR-0005). Channels with no paired_session
 * (telegram/slack/etc.) are absent from the map.
 */
async function loadLatestSessionStates(workspaceId: string): Promise<Map<string, PairedSessionState>> {
    const rows = await channelsRepo.getPairedSessionsForWorkspace(workspaceId)
    const out = new Map<string, PairedSessionState>()
    const seenAt = new Map<string, Date>()
    for (const r of rows) {
        const prev = seenAt.get(r.channelId)
        if (!prev || r.stateChangedAt.getTime() > prev.getTime()) {
            seenAt.set(r.channelId, r.stateChangedAt)
            out.set(r.channelId, r.state)
        }
    }
    return out
}

export const channelsRouter: RouterType = Router()

const VALID_CHANNEL_TYPES = new Set<string>(['telegram', 'slack', 'discord', 'whatsapp', 'signal', 'matrix', 'twilio', 'gmail'])

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export type GmailChannelConfigInput = {
    installedConnectionId?: unknown
    emailAddress?: unknown
} | undefined | null

export type GmailValidationError =
    | 'INVALID_INSTALLED_CONNECTION_ID'
    | 'INVALID_EMAIL_ADDRESS'

/**
 * Pure-input validator for the gmail channel POST config payload.
 * Returns null on success, or an error code on failure.
 */
export function validateGmailChannelConfig(config: GmailChannelConfigInput): GmailValidationError | null {
    if (!config || typeof config !== 'object') return 'INVALID_INSTALLED_CONNECTION_ID'
    const { installedConnectionId, emailAddress } = config as Record<string, unknown>
    if (typeof installedConnectionId !== 'string' || !UUID_RE.test(installedConnectionId)) {
        return 'INVALID_INSTALLED_CONNECTION_ID'
    }
    if (typeof emailAddress !== 'string' || !EMAIL_RE.test(emailAddress) || emailAddress.length > 254) {
        return 'INVALID_EMAIL_ADDRESS'
    }
    return null
}

// ── GET /api/channels ─────────────────────────────────────────────────────────

channelsRouter.get('/', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    try {
        const [rows, sessionStates] = await Promise.all([
            channelsRepo.listByWorkspace(workspaceId),
            loadLatestSessionStates(workspaceId),
        ])
        const items = rows.map((r) => ({ ...r, state: sessionStates.get(r.id) ?? null }))
        res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/channels failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list channels' } })
    }
})

// ── Plexo viewer endpoints (Phase 4c, ADR-0005) ──────────────────────────────
//
// These power /app/channels/* — the host-side generic Channel viewer. Workspace
// access is enforced via Better Auth + ensureWorkspaceAccess (same posture as
// the list/CRUD handlers above). Distinct from /api/plexo/channels/* (HMAC,
// sibling-app-facing) per ADR-0005 §"Consequences" boundary.
//
// Threads and messages return empty-state shells in Phase 4c. Phase 5 lands
// the message-normalization + ingestion path, at which point these handlers
// project rows from `messages` and join `plexo_gmessages.message_dedupe`.

channelsRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.query as Record<string, string>
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for channel id' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    const row = await channelsRepo.getScopedFull(id, workspaceId)
    if (!row) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } })
        return
    }
    const sessionStates = await loadLatestSessionStates(workspaceId)
    res.json({ ...row, state: sessionStates.get(row.id) ?? null })
})

channelsRouter.get('/:id/threads', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.query as Record<string, string>
    if (!UUID_RE.test(id) || !workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Valid id + workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    const row = await channelsRepo.getTypeScoped(id, workspaceId)
    if (!row) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } })
        return
    }

    try {
        // Channel-type-agnostic thread aggregation. For gmessages the
        // session_id prefix is `gmessages:`; we additionally narrow by
        // channelRef.channelId so a workspace with multiple paired channels
        // doesn't bleed threads across them. For other channel types we
        // fall back to source = channel.type and channelRef.channelId.
        const sourceFilter = row.type === 'gmessages' ? 'gmessages' : row.type
        const rows = await channelsRepo.listThreadConversations(workspaceId, sourceFilter, id)

        // Fold: most-recent row per sessionId wins for preview/lastMessageAt;
        // earlier rows in the same session are dropped.
        type ThreadAcc = { id: string; title: string; lastMessagePreview: string; lastMessageAt: string; unreadCount: number }
        const seen = new Set<string>()
        const threads: ThreadAcc[] = []
        for (const r of rows) {
            if (!r.sessionId) continue
            if (seen.has(r.sessionId)) continue
            seen.add(r.sessionId)
            const ref = r.channelRef as { chatId?: string } | null
            const threadId = ref?.chatId ?? r.sessionId.replace(/^gmessages:/, '')
            const preview = r.reply && r.reply.length > 0 ? r.reply : r.message
            threads.push({
                id: threadId,
                title: threadId,
                lastMessagePreview: preview.slice(0, 280),
                lastMessageAt: r.createdAt.toISOString(),
                unreadCount: 0,
            })
        }
        res.json({ threads })
    } catch (err) {
        logger.error({ err, channelId: id }, 'GET /channels/:id/threads failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list threads' } })
    }
})

channelsRouter.get('/:id/threads/:threadId/messages', async (req, res) => {
    const { id, threadId } = req.params
    const { workspaceId } = req.query as Record<string, string>
    if (!UUID_RE.test(id) || !workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Valid id + workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    const row = await channelsRepo.getTypeScoped(id, workspaceId)
    if (!row) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } })
        return
    }

    try {
        const sourceFilter = row.type === 'gmessages' ? 'gmessages' : row.type
        const sessionId = row.type === 'gmessages' ? `gmessages:${threadId}` : threadId
        const rows = await channelsRepo.listThreadMessages(workspaceId, sourceFilter, sessionId)

        // Reverse to ASC so the viewer renders oldest → newest.
        const ascRows = rows.reverse()

        type Msg = {
            id: string
            direction: 'inbound' | 'outbound'
            text: string
            sentAt: string
            attachments: typeof conversations.$inferSelect.attachments
        }
        const messages: Msg[] = []
        for (const r of ascRows) {
            // Inbound shape: row.message is the user-sent text; row.reply may
            // hold an outbound dispatch's text (Phase 5 outbound persistence
            // currently writes a row with reply=text, message='' — see POST
            // handler below). Emit the inbound row only when message has
            // content; emit a virtual outbound row when reply has content.
            if (r.message && r.message.length > 0) {
                messages.push({
                    id: r.id,
                    direction: 'inbound',
                    text: r.message,
                    sentAt: r.createdAt.toISOString(),
                    attachments: r.attachments ?? [],
                })
            }
            if (r.reply && r.reply.length > 0) {
                messages.push({
                    id: r.id + ':out',
                    direction: 'outbound',
                    text: r.reply,
                    sentAt: r.createdAt.toISOString(),
                    attachments: [],
                })
            }
        }
        res.json({ messages })
    } catch (err) {
        logger.error({ err, channelId: id, threadId }, 'GET /channels/:id/threads/:threadId/messages failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list messages' } })
    }
})

channelsRouter.post('/:id/threads/:threadId/messages', async (req, res) => {
    const { id, threadId } = req.params
    const { workspaceId, text } = req.body as { workspaceId?: string; text?: string }
    if (!UUID_RE.test(id) || !workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Valid id + workspaceId required' } })
        return
    }
    if (typeof text !== 'string' || !text.length) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'text required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    const row = await channelsRepo.getTypeScoped(id, workspaceId)
    if (!row) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } })
        return
    }

    if (row.type !== 'gmessages') {
        // Other channel types still 202-echo until their outbound flows ship.
        res.status(202).json({
            id: `pending_${Date.now()}`,
            channelId: id,
            threadId,
            direction: 'outbound',
            text,
            sentAt: new Date().toISOString(),
            pending: true,
        })
        return
    }

    // Find the most-recent live paired session for this channel.
    const session = await channelsRepo.getLiveSession(id, workspaceId)

    if (!session) {
        res.status(409).json({ error: { code: 'SESSION_NOT_LIVE', message: 'No live paired session for this channel' } })
        return
    }

    const idempotencyKey = ulid()
    const sentAt = new Date()
    try {
        await sidecarSessionSend(session.id, threadId, text, idempotencyKey)
    } catch (err) {
        logger.error({ err, channelId: id, threadId, pairedSessionId: session.id }, 'gmessages outbound send failed')
        res.status(502).json({ error: { code: 'SIDECAR_SEND_FAILED', message: 'Sidecar dispatch failed' } })
        return
    }

    // Persist the outbound row so the viewer's GET reflects the optimistic
    // send. Convention: outbound text lives in `reply`; `message` is empty.
    // The GET handler synthesizes direction:'outbound' for rows where reply
    // is non-empty.
    const conversationId = ulid()
    try {
        await channelsRepo.insertOutboundConversation({
            id: conversationId,
            workspaceId,
            sessionId: `gmessages:${threadId}`,
            source: 'gmessages',
            message: '',
            reply: text,
            status: 'complete',
            intent: null,
            channelRef: { channel: 'gmessages', channelId: id, chatId: threadId },
            attachments: [],
            createdAt: sentAt,
        })
    } catch (err) {
        // Don't fail the user-visible response over a logging row.
        logger.warn({ err, channelId: id, threadId }, 'gmessages outbound conversation insert failed')
    }

    res.status(202).json({
        id: conversationId,
        channelId: id,
        threadId,
        direction: 'outbound',
        text,
        sentAt: sentAt.toISOString(),
        pending: true,
    })
})

// ── POST /api/channels ────────────────────────────────────────────────────────

channelsRouter.post('/', async (req, res) => {
    const { workspaceId, type, name, config = {} } = req.body as {
        workspaceId?: string
        type?: string
        name?: string
        config?: Record<string, unknown>
    }

    if (!workspaceId || !UUID_RE.test(workspaceId) || !type || !name) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId, type, name required' } })
        return
    }
    if (!VALID_CHANNEL_TYPES.has(type)) {
        res.status(400).json({ error: { code: 'INVALID_TYPE', message: `Invalid channel type. Valid types: ${[...VALID_CHANNEL_TYPES].join(', ')}` } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    let effectiveConfig: Record<string, unknown> = { ...config }

    // Gmail: dual-purpose connection — channel reuses an installed_connections row.
    // Validate the installedConnection belongs to this workspace AND has registryId='gmail'.
    if (type === 'gmail') {
        const validationErr = validateGmailChannelConfig(config as GmailChannelConfigInput)
        if (validationErr === 'INVALID_INSTALLED_CONNECTION_ID') {
            res.status(400).json({ error: { code: validationErr, message: 'config.installedConnectionId must be a valid UUID' } })
            return
        }
        if (validationErr === 'INVALID_EMAIL_ADDRESS') {
            res.status(400).json({ error: { code: validationErr, message: 'config.emailAddress must be a valid email' } })
            return
        }

        const { installedConnectionId, emailAddress } = config as { installedConnectionId: string; emailAddress: string }
        const conn = await channelsRepo.getGmailConnection(installedConnectionId, workspaceId)
        if (!conn) {
            res.status(400).json({ error: { code: 'GMAIL_CONNECTION_NOT_FOUND', message: 'Gmail connection not found in this workspace' } })
            return
        }

        effectiveConfig = { installedConnectionId, emailAddress, lastHistoryId: null }
    }

    try {
        // Phase O — encrypt sensitive keys (per-channel-type) before persisting.
        // Plaintext effectiveConfig stays in scope for Telegram/Gmail post-insert
        // hooks below; only the DB row carries ciphertext.
        const configToPersist = encryptSensitiveConfigKeys(type as string, effectiveConfig, workspaceId)
        const created = await channelsRepo.insertChannel({
            workspaceId,
            type: type as 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'signal' | 'matrix' | 'twilio' | 'gmail',
            name,
            config: configToPersist,
            enabled: true,
        })
        logger.info({ workspaceId, type, name }, 'Channel created')

        // Auto-register webhook for Telegram bots so the bot is live immediately
        if (type === 'telegram' && created) {
            const cfg = effectiveConfig as { token?: string; bot_token?: string }
            const token = cfg.token ?? cfg.bot_token ?? null
            if (token) {
                void registerTelegramChannel(created.id, token, workspaceId).catch(
                    (err: Error) => logger.warn({ err }, 'Telegram webhook auto-register failed')
                )
            }
        }

        // Gmail: baseline lastHistoryId so the first poll cycle doesn't replay the entire mailbox.
        // Fire-and-forget; on failure leave null and let the next poll baseline.
        if (type === 'gmail' && created) {
            const cfg = effectiveConfig as { installedConnectionId: string }
            void (async () => {
                try {
                    const profile = await fetchGmailProfile(cfg.installedConnectionId, workspaceId)
                    if (profile?.historyId) {
                        // Gmail's sensitive-key set is empty so encrypt is a no-op,
                        // but use the helper for consistency.
                        const baselined = encryptSensitiveConfigKeys(
                            'gmail',
                            { ...effectiveConfig, lastHistoryId: profile.historyId },
                            workspaceId,
                        )
                        await channelsRepo.updateChannelConfig(created.id, baselined)
                        logger.info({ channelId: created.id, historyId: profile.historyId }, 'Gmail channel baselined')
                    }
                } catch (err) {
                    logger.warn({ err, channelId: created.id }, 'Gmail baseline failed — next poll will baseline')
                }
            })()
        }

        res.status(201).json(created)
    } catch (err) {
        logger.error({ err }, 'POST /api/channels failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create channel' } })
    }
})

// ── PATCH /api/channels/:id ───────────────────────────────────────────────────

channelsRouter.patch('/:id', async (req, res) => {
    const { id } = req.params
    const { workspaceId, enabled, config, name } = req.body as {
        workspaceId?: string
        enabled?: boolean
        config?: Record<string, unknown>
        name?: string
    }

    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for channel id' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const update: Record<string, unknown> = {}
        if (enabled !== undefined) update.enabled = enabled
        if (name !== undefined) update.name = name

        if (config !== undefined) {
            const existing = await channelsRepo.getScopedFull(id, workspaceId)
            if (!existing) {
                res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } })
                return
            }
            const filterResult = filterChannelConfigForPatch(existing.type, config)
            if (!filterResult.ok) {
                res.status(400).json({
                    error: {
                        code: filterResult.error.code,
                        message: `config.${filterResult.error.key} cannot be updated via PATCH for ${existing.type} channels`,
                    },
                })
                return
            }
            // Phase O — encrypt the incoming patch before merging into the
            // already-encrypted existing config. Existing ciphertext stays as-is;
            // new sensitive values get encrypted on the way in.
            const filteredAndEncrypted = encryptSensitiveConfigKeys(existing.type, filterResult.filtered, workspaceId)
            const merged = { ...(existing.config ?? {}), ...filteredAndEncrypted }
            update.config = merged
        }

        await channelsRepo.updateScoped(id, workspaceId, update as Parameters<typeof channelsRepo.updateScoped>[2])

        // Re-register Telegram webhook if token or config changed
        if (config) {
            const updated = await channelsRepo.getScopedFull(id, workspaceId)
            if (updated && updated.type === 'telegram') {
                const { decryptSensitiveConfigKeys } = await import('../lib/channel-config-crypto.js')
                const cfg = decryptSensitiveConfigKeys('telegram', (updated.config ?? {}) as Record<string, unknown>, workspaceId) as { token?: string; bot_token?: string }
                const token = cfg.token ?? cfg.bot_token ?? null
                if (token) {
                    void registerTelegramChannel(updated.id, token, workspaceId).catch(
                        (err: Error) => logger.warn({ err }, 'Telegram webhook re-register on PATCH failed')
                    )
                }
            }
        }

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, id }, 'PATCH /api/channels/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── DELETE /api/channels/:id ──────────────────────────────────────────────────

channelsRouter.delete('/:id', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.query as Record<string, string>

    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for channel id' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        await channelsRepo.deleteScoped(id, workspaceId)
        logger.info({ id, workspaceId }, 'Channel deleted')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, id }, 'DELETE /api/channels/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Delete failed' } })
    }
})
