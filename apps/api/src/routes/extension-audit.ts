// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension Audit Trail API (§18)
 *
 * GET  /api/v1/extension-audit?workspaceId=&extensionId=&agentId=&action=&outcome=&from=&to=&limit=&offset=
 *
 * Returns paginated extension/agent audit entries.
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, and, desc } from '@plexo/db'
import { extensionAuditLog } from '@plexo/db'
import { sql } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const extensionAuditRouter: RouterType = Router()

extensionAuditRouter.get('/', async (req, res) => {
    const {
        workspaceId,
        extensionId,
        agentId,
        action,
        outcome,
        from: fromDate,
        to: toDate,
        limit: limitStr = '50',
        offset: offsetStr = '0',
    } = req.query as Record<string, string | undefined>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }

    const limit = Math.min(parseInt(limitStr ?? '50', 10) || 50, 200)
    const offset = parseInt(offsetStr ?? '0', 10) || 0

    try {
        const conditions = [eq(extensionAuditLog.workspaceId, workspaceId)]

        if (extensionId) conditions.push(eq(extensionAuditLog.extensionId, extensionId))
        if (agentId) conditions.push(eq(extensionAuditLog.agentId, agentId))
        if (action) conditions.push(eq(extensionAuditLog.action, action))
        if (outcome) conditions.push(eq(extensionAuditLog.outcome, outcome))
        if (fromDate) conditions.push(sql`${extensionAuditLog.createdAt} >= ${new Date(fromDate)}`)
        if (toDate) conditions.push(sql`${extensionAuditLog.createdAt} <= ${new Date(toDate)}`)

        const [rows, countResult] = await Promise.all([
            db.select()
                .from(extensionAuditLog)
                .where(and(...conditions))
                .orderBy(desc(extensionAuditLog.createdAt))
                .limit(limit)
                .offset(offset),
            db.select({ count: sql<number>`count(*)::int` })
                .from(extensionAuditLog)
                .where(and(...conditions)),
        ])

        res.json({
            items: rows,
            total: countResult[0]?.count ?? 0,
        })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/extension-audit failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch extension audit log' } })
    }
})
