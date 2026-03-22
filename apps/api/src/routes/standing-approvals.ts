// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Standing Approvals API (§23)
 *
 * GET    /api/v1/standing-approvals?workspaceId=
 * POST   /api/v1/standing-approvals
 * DELETE /api/v1/standing-approvals/:id
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq } from '@plexo/db'
import { standingApprovals } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const standingApprovalsRouter: RouterType = Router()

// List standing approvals for a workspace
standingApprovalsRouter.get('/', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const rows = await db.select()
            .from(standingApprovals)
            .where(eq(standingApprovals.workspaceId, workspaceId))
        res.json({ items: rows })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/standing-approvals failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list standing approvals' } })
    }
})

// Create a standing approval
standingApprovalsRouter.post('/', async (req, res) => {
    const { workspaceId, trigger, actionPattern, expiresAt } = req.body as {
        workspaceId?: string
        trigger?: string
        actionPattern?: string
        expiresAt?: string
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!trigger || !actionPattern) {
        res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'trigger and actionPattern required' } })
        return
    }
    try {
        const [row] = await db.insert(standingApprovals)
            .values({
                workspaceId,
                trigger,
                actionPattern,
                expiresAt: expiresAt ? new Date(expiresAt) : undefined,
            })
            .returning()
        res.status(201).json(row)
    } catch (err) {
        logger.error({ err }, 'POST /api/v1/standing-approvals failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create standing approval' } })
    }
})

// Revoke a standing approval
standingApprovalsRouter.delete('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || !UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    try {
        const [deleted] = await db.delete(standingApprovals)
            .where(eq(standingApprovals.id, id))
            .returning()
        if (!deleted) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Standing approval not found' } })
            return
        }
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'DELETE /api/v1/standing-approvals/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke standing approval' } })
    }
})
