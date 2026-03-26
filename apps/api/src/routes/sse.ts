// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { registerClient, unregisterClient } from '../sse-emitter.js'
import { optionalSupabaseAuth } from '../middleware/supabase-auth.js'
import { db, eq, and } from '@plexo/db'
import { workspaceMembers } from '@plexo/db'

export const sseRouter: RouterType = Router()

sseRouter.get('/', optionalSupabaseAuth, async (req, res) => {
    const workspaceId = (req.query.workspaceId as string) ?? 'global'

    // Validate workspace access — authenticated user must be a member
    if (workspaceId !== 'global' && req.user) {
        try {
            const [membership] = await db.select({ userId: workspaceMembers.userId })
                .from(workspaceMembers)
                .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.user.id)))
                .limit(1)
            if (!membership) {
                res.status(403).json({ error: 'Not a member of this workspace' })
                return
            }
        } catch {
            // DB error — allow connection (non-fatal for SSE)
        }
    }

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
