// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { registerClient, unregisterClient } from '../sse-emitter.js'
import { requireAuth } from '../middleware/auth.js'
import * as membersRepo from '../repositories/members.repository.js'
import { logger } from '../logger.js'

export const sseRouter: RouterType = Router()

sseRouter.get('/', requireAuth, async (req, res) => {
    const user = req.user!
    const workspaceId = (req.query.workspaceId as string) ?? 'global'

    // Global stream requires super-admin; workspace stream requires membership
    if (workspaceId === 'global') {
        if (!user.isSuperAdmin) {
            res.status(403).json({ error: 'Super-admin required for global SSE stream' })
            return
        }
    } else {
        try {
            const member = await membersRepo.isMember(workspaceId, user.id)
            if (!member) {
                res.status(403).json({ error: 'Not a member of this workspace' })
                return
            }
        } catch (err) {
            // DB error — deny by default for security
            logger.error({ err, workspaceId, userId: user.id }, 'GET /sse: workspace membership check failed')
            res.status(503).json({ error: 'Unable to verify workspace membership' })
            return
        }
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    })

    const clientId = registerClient(workspaceId, res, user.id)
    if (!clientId) return // connection rejected by cap limit

    // Initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId, timestamp: new Date().toISOString() })}\n\n`)

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n')
    }, 30_000)

    req.on('close', () => {
        clearInterval(heartbeat)
        unregisterClient(workspaceId, clientId)
    })
})
