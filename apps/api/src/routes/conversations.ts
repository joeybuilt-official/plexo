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

// ── PATCH /api/v1/conversations/:id ───────────────────────────────────────────
// DD-5: update per-conversation model + system-prompt overrides. Body:
//   { modelOverride?: string | null, systemPromptOverride?: string | null }
// `null` clears a field; omitting it leaves it untouched. Auth + workspace
// access guarded like the GET above.

conversationsRouter.patch('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid id required (max 64 chars)' } })
        return
    }
    const { modelOverride, systemPromptOverride } = (req.body ?? {}) as {
        modelOverride?: string | null
        systemPromptOverride?: string | null
    }
    if (modelOverride !== undefined && modelOverride !== null && typeof modelOverride !== 'string') {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'modelOverride must be a string or null' } })
        return
    }
    if (systemPromptOverride !== undefined && systemPromptOverride !== null && typeof systemPromptOverride !== 'string') {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'systemPromptOverride must be a string or null' } })
        return
    }
    if (modelOverride !== undefined && modelOverride && modelOverride.length > 256) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'modelOverride max 256 chars' } })
        return
    }
    if (systemPromptOverride !== undefined && systemPromptOverride && systemPromptOverride.length > 32_000) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'systemPromptOverride max 32000 chars' } })
        return
    }
    try {
        const existing = await conversationsRepo.getConversationById(id)
        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, existing.workspaceId)) return
        const updated = await conversationsRepo.updateConversationOverrides(id, {
            modelOverride: modelOverride === undefined ? undefined : (modelOverride ?? null),
            systemPromptOverride: systemPromptOverride === undefined ? undefined : (systemPromptOverride ?? null),
        })
        res.json(updated)
    } catch (err) {
        logger.error({ err, id }, 'PATCH /api/v1/conversations/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update conversation overrides' } })
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

        // Session thread view: all turns for a specific session ID (chronological).
        // Cap is a sanity bound, not a format limit: web sessions are minted as
        // `web-<workspaceUuid>-<clientUuid>` = 77 chars, so a 64 cap 400'd EVERY
        // web thread ("No turns found" despite persisted rows). 128 covers the
        // current format with headroom while still bounding the query param.
        if (sessionId && sessionId.length > 128) {
            res.status(400).json({ error: { code: 'INVALID_SESSION', message: 'sessionId max 128 chars' } })
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
                modelOverride: row.model_override,
                systemPromptOverride: row.system_prompt_override,
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
