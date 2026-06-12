// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension Audit Trail API (§18)
 *
 * GET /api/v1/extension-audit
 *   Query params:
 *     workspaceId    (required, UUID)
 *     extensionId    filter by owning extension (e.g. @plexo/research-agent)
 *     agentId        filter by agent (legacy/optional)
 *     tool           filter by tool name (exact match on `target`)
 *     action         filter by action type
 *     outcome        success | failure | denied | timeout
 *     from, to       ISO timestamps — date-range filter
 *     limit          default 50, max 200
 *     offset         default 0
 *
 * GET /api/v1/extension-audit/by-extension
 *   Returns last N entries grouped by extension, for the "grouped"
 *   audit page view. Same filters apply.
 *
 * Phase 7 — rows carry extension_name and extension_version for rich
 * rendering without a join.
 */
import { Router, type Router as RouterType } from 'express'
import * as auditRepo from '../repositories/extension-audit.repository.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const extensionAuditRouter: RouterType = Router()

extensionAuditRouter.get('/', async (req, res) => {
    const q = req.query as Record<string, string | undefined>
    const { workspaceId, limit: limitStr = '50', offset: offsetStr = '0' } = q

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
        const [rows, total] = await Promise.all([
            auditRepo.listAuditLog(q as auditRepo.AuditFilters, limit, offset),
            auditRepo.countAuditLog(q as auditRepo.AuditFilters),
        ])

        res.json({ items: rows, total })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/extension-audit failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch tool audit log' } })
    }
})

/**
 * Grouped view: returns { groups: [{ extensionId, extensionName, count, items: [...] }] }
 * Limits per-group to `perGroup` (default 5).
 */
extensionAuditRouter.get('/by-extension', async (req, res) => {
    const q = req.query as Record<string, string | undefined>
    const { workspaceId, perGroup: perGroupStr = '5' } = q

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }

    const perGroup = Math.min(parseInt(perGroupStr, 10) || 5, 50)

    try {
        // Pull last 500 rows matching filters, then bucket in memory.
        // Cheap vs a window function and good enough for UI preview scale.
        const rows = await auditRepo.listForGrouping(q as auditRepo.AuditFilters, 500)

        type Row = typeof rows[number]
        const groups = new Map<string, { extensionId: string; extensionName: string | null; count: number; items: Row[] }>()
        for (const row of rows) {
            const key = row.extensionId
            let g = groups.get(key)
            if (!g) {
                g = { extensionId: key, extensionName: row.extensionName, count: 0, items: [] }
                groups.set(key, g)
            }
            g.count++
            if (g.items.length < perGroup) g.items.push(row)
        }

        res.json({ groups: Array.from(groups.values()) })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/extension-audit/by-extension failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch grouped audit log' } })
    }
})
