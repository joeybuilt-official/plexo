// SPDX-License-Identifier: AGPL-3.0-only
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
import { db, eq, and, desc } from '@plexo/db'
import { auditLog, users } from '@plexo/db'
import { sql } from '@plexo/db'
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

    const limit = Math.min(parseInt(limitStr, 10) || 50, 200)

    try {
        const conditions = [eq(auditLog.workspaceId, workspaceId)]

        if (actionFilter) {
            // Prefix match: 'member' matches 'member.add', 'member.remove', etc.
            conditions.push(sql`${auditLog.action} LIKE ${actionFilter + '%'}`)
        }

        if (before) {
            conditions.push(sql`${auditLog.createdAt} < ${new Date(before)}`)
        }

        const rows = await db
            .select({
                id: auditLog.id,
                action: auditLog.action,
                resource: auditLog.resource,
                resourceId: auditLog.resourceId,
                metadata: auditLog.metadata,
                ip: auditLog.ip,
                createdAt: auditLog.createdAt,
                userId: auditLog.userId,
                userName: users.name,
                userEmail: users.email,
            })
            .from(auditLog)
            .leftJoin(users, eq(auditLog.userId, users.id))
            .where(and(...conditions))
            .orderBy(desc(auditLog.createdAt))
            .limit(limit)

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
