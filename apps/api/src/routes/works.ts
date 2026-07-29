// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Works API — list all works (artifacts) across a workspace.
 *
 * GET /api/v1/works?workspaceId=&kind=&limit=&cursor=&sort=
 */

import { Router, type Router as RouterType } from 'express'
import * as worksRepo from '../repositories/works.repository.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'

export const worksRouter: RouterType = Router()

// ── GET /api/v1/works?workspaceId=&kind=&source=&limit=&cursor=&sort= ────

worksRouter.get('/', async (req, res) => {
    const {
        workspaceId,
        kind,
        source,
        limit = '50',
        cursor,
        sort = 'newest',
    } = req.query as Record<string, string>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.json({ items: [], nextCursor: null, total: 0 })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    const cap = Math.min(parseInt(limit, 10) || 50, 100)

    try {
        const rows = await worksRepo.listWorks({ workspaceId, kind, source, cursor, sort, cap })

        const items = rows.map(r => ({
            id:             r.id,
            filename:       r.filename,
            kind:           r.kind,
            type:           r.type,
            meta:           (r.meta as Record<string, unknown> | null) ?? {},
            currentVersion: r.currentVersion,
            taskId:         r.taskId,
            projectId:      r.projectId,
            createdAt:      r.createdAt,
            updatedAt:      r.updatedAt,
            contentLength:  r.contentLength ?? 0,
            taskSource:     r.taskSource ?? null,
            taskSummary:    r.taskSummary ?? null,
        }))

        const nextCursor = items.length === cap
            ? items[items.length - 1]?.id ?? null
            : null

        res.json({ items, nextCursor, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/works failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch works' } })
    }
})
