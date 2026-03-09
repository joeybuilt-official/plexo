// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { registerClient, unregisterClient } from '../sse-emitter.js'

export const sseRouter: RouterType = Router()

sseRouter.get('/', (req, res) => {
    // workspaceId from query or session — Phase 3 will validate via auth middleware
    const workspaceId = (req.query.workspaceId as string) ?? 'global'

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    })

    const clientId = registerClient(workspaceId, res)

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
