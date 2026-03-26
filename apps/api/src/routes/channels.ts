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
import { channels } from '@plexo/db'
import { logger } from '../logger.js'
import { registerTelegramChannel } from './telegram.js'
import { UUID_RE } from '../validation.js'

export const channelsRouter: RouterType = Router()


// ── GET /api/channels ─────────────────────────────────────────────────────────

channelsRouter.get('/', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const items = await db
            .select()
            .from(channels)
            .where(eq(channels.workspaceId, workspaceId))
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

    try {
        const [created] = await db.insert(channels).values({
            workspaceId,
            type: type as 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'signal' | 'matrix',
            name,
            config,
            enabled: true,
        }).returning()
        logger.info({ workspaceId, type, name }, 'Channel created')

        // Auto-register webhook for Telegram bots so the bot is live immediately
        if (type === 'telegram' && created) {
            const cfg = config as { token?: string; bot_token?: string }
            const token = cfg.token ?? cfg.bot_token ?? null
            if (token) {
                void registerTelegramChannel(created.id, token, workspaceId).catch(
                    (err: Error) => logger.warn({ err }, 'Telegram webhook auto-register failed')
                )
            }
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

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

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

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

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
