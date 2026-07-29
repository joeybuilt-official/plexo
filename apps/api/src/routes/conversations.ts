// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import * as conversationsRepo from '../repositories/conversations.repository.js'

export const conversationsRouter: RouterType = Router()


// ── GET /api/v1/conversations/:id ─────────────────────────────────────────────
// Returns a single conversation record by its ID (ULID).

conversationsRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid id required (max 64 chars)' } })
        return
    }
    try {
        const item = await conversationsRepo.getConversationById(id)
        if (!item) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, item.workspaceId)) return
        res.json(item)
    } catch (err) {
        logger.error({ err, id }, 'GET /api/v1/conversations/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch conversation' } })
    }
})

// ── GET /api/v1/conversations?workspaceId=&limit=&cursor=&sessionId= ─────────
// Returns conversation records for a workspace, newest first.
// If ?sessionId= is provided, returns all turns for that session in chronological order.
// If ?groupBySession=true, returns one entry per session (most recent turn per session).

conversationsRouter.get('/', async (req, res) => {
    const { workspaceId, limit = '50', cursor, sessionId, groupBySession } = req.query as Record<string, string>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.json({ items: [], nextCursor: null })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const lim = Math.min(parseInt(limit, 10) || 50, 200)

        // Session thread view: all turns for a specific session ID (chronological)
        if (sessionId && sessionId.length > 64) {
            res.status(400).json({ error: { code: 'INVALID_SESSION', message: 'sessionId max 64 chars' } })
            return
        }
        if (sessionId) {
            const items = await conversationsRepo.listSessionTurns(workspaceId, sessionId, lim)
            res.json({ items, nextCursor: null, sessionId })
            return
        }

        // Grouped view: one row per session (the most recent turn), plus a turn count.
        // Falls back to per-row view for conversations without a sessionId.
        if (groupBySession === 'true') {
            const rawRows = await conversationsRepo.listGroupedBySession(workspaceId, cursor, lim)
            // Raw execute returns snake_case columns. Map them to camelCase to match the frontend ConversationItem type.
            const items = (rawRows as Array<Record<string, unknown>>).map((row) => ({
                id: row.id,
                workspaceId: row.workspace_id,
                sessionId: row.session_id,
                source: row.source,
                message: row.message,
                reply: row.reply,
                errorMsg: row.error_msg,
                status: row.status,
                intent: row.intent,
                taskId: row.task_id,
                channelRef: row.channel_ref,
                attachments: row.attachments,
                createdAt: row.created_at,
                turn_count: row.turn_count,
            }))
            const nextCursor = items.length === lim ? (items[items.length - 1]?.id as string ?? null) : null
            res.json({ items, nextCursor })
            return
        }

        // Default: flat list, newest first
        const items = await conversationsRepo.listFlat(workspaceId, cursor, lim)

        const nextCursor = items.length === lim ? (items[items.length - 1]?.id ?? null) : null

        res.json({ items, nextCursor })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/conversations failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch conversations' } })
    }
})
