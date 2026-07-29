// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Audit log API
 *
 * GET /api/audit?workspaceId=&limit=50&action=&before=
 *
 * Returns paginated audit log entries for a workspace.
 * Supports filtering by action prefix (e.g. action=member will match member.add, member.remove).
 */
import { Router, type Router as RouterType } from 'express'
import * as auditRepo from '../repositories/audit.repository.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const auditRouter: RouterType = Router()


auditRouter.get('/', async (req, res) => {
    const {
        workspaceId,
        limit: limitStr = '50',
        action: actionFilter,
        before,
    } = req.query as {
        workspaceId?: string
        limit?: string
        action?: string
        before?: string  // ISO timestamp cursor for pagination
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }

    if (actionFilter && actionFilter.length > 100) {
        res.status(400).json({ error: { code: 'INVALID_ACTION', message: 'action filter max 100 chars' } })
        return
    }
    if (before) {
        const d = new Date(before)
        if (isNaN(d.getTime())) {
            res.status(400).json({ error: { code: 'INVALID_DATE', message: 'before must be a valid ISO 8601 timestamp' } })
            return
        }
    }

    const limit = Math.min(parseInt(limitStr, 10) || 50, 200)

    try {
        const rows = await auditRepo.listAuditEntries(workspaceId, {
            // Prefix match: 'member' matches 'member.add', 'member.remove', etc.
            actionPrefix: actionFilter,
            before: before ? new Date(before) : undefined,
            limit,
        })

        res.json({
            items: rows,
            total: rows.length,
            hasMore: rows.length === limit,
        })
    } catch (err) {
        logger.error({ err }, 'GET /api/audit failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch audit log' } })
    }
})
