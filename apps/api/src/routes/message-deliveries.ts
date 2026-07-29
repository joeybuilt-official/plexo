// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { queryDeliveries } from '../delivery-tracker.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'

export const messageDeliveriesRouter: RouterType = Router()

// ── GET /api/v1/message-deliveries?workspaceId=&channel=&status=&limit=&offset= ──

messageDeliveriesRouter.get('/', async (req, res) => {
    const { workspaceId, channel, status, limit = '50', offset = '0' } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'Valid workspaceId UUID required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    const validChannels = ['telegram', 'slack', 'discord']
    if (channel && !validChannels.includes(channel)) {
        res.status(400).json({ error: { code: 'INVALID_CHANNEL', message: `channel must be one of: ${validChannels.join(', ')}` } })
        return
    }

    const validStatuses = ['sent', 'failed', 'rejected', 'empty_response']
    if (status && !validStatuses.includes(status)) {
        res.status(400).json({ error: { code: 'INVALID_STATUS', message: `status must be one of: ${validStatuses.join(', ')}` } })
        return
    }

    try {
        const items = await queryDeliveries({
            workspaceId,
            channel: channel || undefined,
            status: status || undefined,
            limit: Math.min(parseInt(limit, 10) || 50, 200),
            offset: parseInt(offset, 10) || 0,
        })

        res.json({ items })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/message-deliveries failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch message deliveries' } })
    }
})
