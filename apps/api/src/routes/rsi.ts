// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import * as rsiRepo from '../repositories/rsi.repository.js'
import { logger } from '../logger.js'
import { emitRsiProposalResolved } from '../analytics/events.js'
import { UUID_RE } from '../validation.js'

export const rsiRouter: RouterType = Router({ mergeParams: true })


// GET /api/v1/workspaces/:id/rsi/proposals
rsiRouter.get('/proposals', async (req, res, next) => {
    try {
        const { id: workspaceId } = req.params as Record<string, string>

        if (!workspaceId || !UUID_RE.test(workspaceId)) {
            return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid workspace ID' } })
        }

        const proposals = await rsiRepo.listProposals(workspaceId)

        res.json({ items: proposals })
    } catch (err) {
        next(err)
    }
})

// POST /api/v1/workspaces/:id/rsi/proposals/:proposalId/approve
rsiRouter.post('/proposals/:proposalId/approve', async (req, res, next) => {
    try {
        const { id: workspaceId, proposalId } = req.params as Record<string, string>

        if (!workspaceId || !UUID_RE.test(workspaceId) || !proposalId || !UUID_RE.test(proposalId)) {
            return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid workspace or proposal ID' } })
        }

        const updated = await rsiRepo.approveProposal(proposalId, workspaceId)

        if (!updated) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Proposal not found' } })
        }

        // Fire shadow test non-fatally after approve
        void import('@plexo/agent/introspection/shadow-test')
            .then(({ runShadowTest }) => runShadowTest(proposalId, workspaceId))
            .catch(err => logger.warn({ err, proposalId }, 'Shadow test failed non-fatally'))

        emitRsiProposalResolved({ anomalyType: updated.anomalyType, action: 'approved' })
        res.json(updated)
    } catch (err) {
        next(err)
    }
})

// POST /api/v1/workspaces/:id/rsi/proposals/:proposalId/reject
rsiRouter.post('/proposals/:proposalId/reject', async (req, res, next) => {
    try {
        const { id: workspaceId, proposalId } = req.params as Record<string, string>

        if (!workspaceId || !UUID_RE.test(workspaceId) || !proposalId || !UUID_RE.test(proposalId)) {
            return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid workspace or proposal ID' } })
        }

        const updated = await rsiRepo.rejectProposal(proposalId, workspaceId)

        if (!updated) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Proposal not found' } })
        }

        emitRsiProposalResolved({ anomalyType: updated.anomalyType, action: 'rejected' })
        res.json(updated)
    } catch (err) {
        next(err)
    }
})

// GET /api/v1/workspaces/:id/rsi/proposals/:proposalId/test-results
rsiRouter.get('/proposals/:proposalId/test-results', async (req, res, next) => {
    try {
        const { id: workspaceId, proposalId } = req.params as Record<string, string>

        if (!workspaceId || !UUID_RE.test(workspaceId) || !proposalId || !UUID_RE.test(proposalId)) {
            return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid workspace or proposal ID' } })
        }

        // Verify the proposal belongs to this workspace
        const proposal = await rsiRepo.getProposalScoped(proposalId, workspaceId)

        if (!proposal) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Proposal not found' } })
        }

        const results = await rsiRepo.listTestResults(proposalId)

        // Compute aggregate summary for the UI
        const withBaseline = results.filter(r => r.baselineQuality !== null)
        const withShadow = results.filter(r => r.shadowQuality !== null)
        const avgBaseline = withBaseline.length > 0
            ? withBaseline.reduce((s, r) => s + (r.baselineQuality ?? 0), 0) / withBaseline.length
            : null
        const avgShadow = withShadow.length > 0
            ? withShadow.reduce((s, r) => s + (r.shadowQuality ?? 0), 0) / withShadow.length
            : null

        res.json({
            items: results,
            summary: {
                taskCount: results.length,
                avgBaselineQuality: avgBaseline,
                avgShadowQuality: avgShadow,
                qualityDelta: avgBaseline !== null && avgShadow !== null
                    ? avgShadow - avgBaseline
                    : null,
            },
        })
    } catch (err) {
        next(err)
    }
})
