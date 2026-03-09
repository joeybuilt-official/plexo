// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { listPending, getDecision, resolveDecision } from '@plexo/agent/one-way-door'
import { emitToWorkspace } from '../sse-emitter.js'
import { logger } from '../logger.js'

export const owdRouter: RouterType = Router()

// ── GET /api/approvals?workspaceId= ─────────────────────────────────────────

owdRouter.get('/', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    try {
        const pending = await listPending(workspaceId)
        res.json({ items: pending, total: pending.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/approvals failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list approvals' } })
    }
})

// ── GET /api/approvals/:id ────────────────────────────────────────────────────

owdRouter.get('/:id', async (req, res) => {
    try {
        const record = await getDecision(req.params.id)
        if (!record) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found or expired' } })
            return
        }
        res.json(record)
    } catch (err) {
        logger.error({ err }, 'GET /api/approvals/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get approval' } })
    }
})

// ── POST /api/approvals/:id/approve ──────────────────────────────────────────

owdRouter.post('/:id/approve', async (req, res) => {
    const decidedBy = (req.body as { user?: string }).user ?? 'dashboard'
    try {
        const updated = await resolveDecision(req.params.id, 'approved', decidedBy)
        if (!updated) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found, expired, or already resolved' } })
            return
        }
        emitToWorkspace(updated.workspaceId, { type: 'owd_approved', id: updated.id, operation: updated.operation })
        logger.info({ id: updated.id, decidedBy }, 'One-way door approved')
        res.json(updated)
    } catch (err) {
        logger.error({ err }, 'POST /api/approvals/:id/approve failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve' } })
    }
})

// ── POST /api/approvals/:id/reject ───────────────────────────────────────────

owdRouter.post('/:id/reject', async (req, res) => {
    const decidedBy = (req.body as { user?: string }).user ?? 'dashboard'
    try {
        const updated = await resolveDecision(req.params.id, 'rejected', decidedBy)
        if (!updated) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found, expired, or already resolved' } })
            return
        }
        emitToWorkspace(updated.workspaceId, { type: 'owd_rejected', id: updated.id, operation: updated.operation })
        logger.info({ id: updated.id, decidedBy }, 'One-way door rejected')
        res.json(updated)
    } catch (err) {
        logger.error({ err }, 'POST /api/approvals/:id/reject failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject' } })
    }
})
