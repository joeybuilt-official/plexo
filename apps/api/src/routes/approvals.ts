// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { listPending, getDecision, resolveDecision } from '@plexo/agent/one-way-door'
import * as standingApprovalsRepo from '../repositories/standing-approvals.repository.js'
import { emitToWorkspace } from '../sse-emitter.js'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'

// OWD IDs are 24-char hex (randomBytes(12)), not UUIDs
const OWD_ID_RE = /^[a-f0-9]{24}$/
const isValidOwdId = (id: string) => UUID_RE.test(id) || OWD_ID_RE.test(id)

export const owdRouter: RouterType = Router()

// ── GET /api/approvals?workspaceId= ─────────────────────────────────────────

owdRouter.get('/', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'Valid workspaceId UUID required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
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
    if (!isValidOwdId(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid approval ID required' } })
        return
    }
    try {
        const record = await getDecision(req.params.id)
        if (!record) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found or expired' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, record.workspaceId)) return
        res.json(record)
    } catch (err) {
        logger.error({ err }, 'GET /api/approvals/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get approval' } })
    }
})

// ── POST /api/approvals/:id/approve ──────────────────────────────────────────

owdRouter.post('/:id/approve', async (req, res) => {
    if (!isValidOwdId(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid approval ID required' } })
        return
    }
    const decidedBy = (req.body as { user?: string }).user ?? 'dashboard'
    try {
        const record = await getDecision(req.params.id)
        if (!record) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found, expired, or already resolved' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, record.workspaceId)) return
        const updated = await resolveDecision(req.params.id, 'approved', decidedBy)
        if (!updated) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found, expired, or already resolved' } })
            return
        }
        emitToWorkspace(updated.workspaceId, { type: 'owd_approved', id: updated.id, operation: updated.operation })
        trackEvent('approval.approved', 'info', { approvalId: updated.id, operation: updated.operation, decidedBy, workspaceId: updated.workspaceId })
        logger.info({ id: updated.id, decidedBy }, 'One-way door approved')
        res.json(updated)
    } catch (err) {
        logger.error({ err }, 'POST /api/approvals/:id/approve failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve' } })
    }
})

// ── POST /api/approvals/:id/approve-and-remember ─────────────────────────────
// UI-audit Phase 1 — broken-flow triage. The /app/approvals dashboard has
// had an "Approve & remember" button calling this endpoint; the handler
// didn't exist, so the flow failed silently with a generic toast. Wire it
// up: same resolveDecision call as /:id/approve, then insert a standing
// approval keyed by the approval's `operation` string. Future identical
// operations will auto-approve against the standing row.
//
// Body: { user?: string }  (same shape as /approve)
// Returns 200 { ok: true, standingApprovalId } on success.
// Returns 404 if the decision is missing / already resolved.
// Returns 200 { ok: true, standingApprovalId: null, warning: ... } if the
// decision resolved but the standing-row insert failed (we don't want to
// block the user on a bookkeeping failure — the main action succeeded).

owdRouter.post('/:id/approve-and-remember', async (req, res) => {
    if (!isValidOwdId(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid approval ID required' } })
        return
    }
    const decidedBy = (req.body as { user?: string }).user ?? 'dashboard'
    try {
        const record = await getDecision(req.params.id)
        if (!record) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found, expired, or already resolved' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, record.workspaceId)) return
        const updated = await resolveDecision(req.params.id, 'approved', decidedBy)
        if (!updated) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found, expired, or already resolved' } })
            return
        }

        // Pattern derivation: exact-match on the approval's operation
        // string. The `operation` field is the canonical tool+action
        // identifier produced by the executor (e.g. "github__create_pr").
        // Using it for both trigger + actionPattern means any future
        // identical operation in the same workspace will match.
        let standingApprovalId: string | null = null
        try {
            const row = await standingApprovalsRepo.create({
                workspaceId: updated.workspaceId,
                trigger: updated.operation,
                actionPattern: updated.operation,
            })
            standingApprovalId = row?.id ?? null
        } catch (insertErr) {
            // Log but don't fail — the approve half already succeeded and
            // the user's primary action is complete.
            logger.error({ err: insertErr, approvalId: updated.id }, 'standing_approvals insert failed during approve-and-remember')
        }

        emitToWorkspace(updated.workspaceId, { type: 'owd_approved', id: updated.id, operation: updated.operation })
        if (standingApprovalId) {
            emitToWorkspace(updated.workspaceId, { type: 'standing_approval_created', id: standingApprovalId, trigger: updated.operation })
        }
        trackEvent('approval.approve_and_remember', 'info', {
            approvalId: updated.id,
            operation: updated.operation,
            decidedBy,
            workspaceId: updated.workspaceId,
            standingApprovalId,
        })
        logger.info({ id: updated.id, decidedBy, standingApprovalId }, 'One-way door approved + remembered')

        res.json({
            ok: true,
            standingApprovalId,
            ...(standingApprovalId ? {} : { warning: 'Approved, but failed to persist standing approval — it will still prompt next time.' }),
        })
    } catch (err) {
        logger.error({ err }, 'POST /api/approvals/:id/approve-and-remember failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve and remember' } })
    }
})

// ── POST /api/approvals/:id/reject ───────────────────────────────────────────

owdRouter.post('/:id/reject', async (req, res) => {
    if (!isValidOwdId(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid approval ID required' } })
        return
    }
    const decidedBy = (req.body as { user?: string }).user ?? 'dashboard'
    try {
        const record = await getDecision(req.params.id)
        if (!record) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found, expired, or already resolved' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, record.workspaceId)) return
        const updated = await resolveDecision(req.params.id, 'rejected', decidedBy)
        if (!updated) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found, expired, or already resolved' } })
            return
        }
        emitToWorkspace(updated.workspaceId, { type: 'owd_rejected', id: updated.id, operation: updated.operation })
        trackEvent('approval.rejected', 'warning', { approvalId: updated.id, operation: updated.operation, decidedBy, workspaceId: updated.workspaceId })
        logger.info({ id: updated.id, decidedBy }, 'One-way door rejected')
        res.json(updated)
    } catch (err) {
        logger.error({ err }, 'POST /api/approvals/:id/reject failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject' } })
    }
})
