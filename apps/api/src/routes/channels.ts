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
import { db, eq, and } from '@plexo/db'
import { channels, installedConnections } from '@plexo/db'
import { logger } from '../logger.js'
import { registerTelegramChannel } from './telegram.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { fetchGmailProfile } from '../lib/gmail-client.js'

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
        const items = await db
            .select()
            .from(channels)
            .where(eq(channels.workspaceId, workspaceId))
            .limit(200)
        res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/channels failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list channels' } })
    }
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
        const [conn] = await db.select({ id: installedConnections.id })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.id, installedConnectionId),
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.registryId, 'gmail'),
            ))
            .limit(1)
        if (!conn) {
            res.status(400).json({ error: { code: 'GMAIL_CONNECTION_NOT_FOUND', message: 'Gmail connection not found in this workspace' } })
            return
        }

        effectiveConfig = { installedConnectionId, emailAddress, lastHistoryId: null }
    }

    try {
        const [created] = await db.insert(channels).values({
            workspaceId,
            type: type as 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'signal' | 'matrix' | 'twilio' | 'gmail',
            name,
            config: effectiveConfig,
            enabled: true,
        }).returning()
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
                        await db.update(channels)
                            .set({ config: { ...effectiveConfig, lastHistoryId: profile.historyId } })
                            .where(eq(channels.id, created.id))
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
        if (config !== undefined) update.config = config
        if (name !== undefined) update.name = name

        await db.update(channels)
            .set(update)
            .where(and(eq(channels.id, id), eq(channels.workspaceId, workspaceId)))

        // Re-register Telegram webhook if token or config changed
        if (config) {
            const [updated] = await db.select().from(channels)
                .where(and(eq(channels.id, id), eq(channels.workspaceId, workspaceId)))
                .limit(1)
            if (updated && updated.type === 'telegram') {
                const cfg = (updated.config ?? {}) as { token?: string; bot_token?: string }
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
        await db.delete(channels)
            .where(and(eq(channels.id, id), eq(channels.workspaceId, workspaceId)))
        logger.info({ id, workspaceId }, 'Channel deleted')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, id }, 'DELETE /api/channels/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Delete failed' } })
    }
})
