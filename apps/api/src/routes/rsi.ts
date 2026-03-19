// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, rsiProposals, rsiTestResults, eq, and, desc } from '@plexo/db'
import { logger } from '../logger.js'
import { emitRsiProposalResolved } from '../telemetry/events.js'
import { UUID_RE } from '../validation.js'

export const rsiRouter: RouterType = Router({ mergeParams: true })


// GET /api/v1/workspaces/:id/rsi/proposals
rsiRouter.get('/proposals', async (req, res, next) => {
    try {
        const { id: workspaceId } = req.params as Record<string, string>

        if (!workspaceId || !UUID_RE.test(workspaceId)) {
            return res.status(400).json({ error: 'Invalid workspace ID' })
        }

        const proposals = await db.select()
            .from(rsiProposals)
            .where(eq(rsiProposals.workspaceId, workspaceId))
            .orderBy(desc(rsiProposals.createdAt))
            .limit(50)

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
            return res.status(400).json({ error: 'Invalid workspace or proposal ID' })
        }

        const [updated] = await db.update(rsiProposals)
            .set({ status: 'approved', approvedAt: new Date() })
            .where(and(eq(rsiProposals.id, proposalId), eq(rsiProposals.workspaceId, workspaceId)))
            .returning()

        if (!updated) {
            return res.status(404).json({ error: 'Proposal not found' })
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
            return res.status(400).json({ error: 'Invalid workspace or proposal ID' })
        }

        const [updated] = await db.update(rsiProposals)
            .set({ status: 'rejected', rejectedAt: new Date() })
            .where(and(eq(rsiProposals.id, proposalId), eq(rsiProposals.workspaceId, workspaceId)))
            .returning()

        if (!updated) {
            return res.status(404).json({ error: 'Proposal not found' })
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
            return res.status(400).json({ error: 'Invalid workspace or proposal ID' })
        }

        // Verify the proposal belongs to this workspace
        const [proposal] = await db.select({ id: rsiProposals.id })
            .from(rsiProposals)
            .where(and(eq(rsiProposals.id, proposalId), eq(rsiProposals.workspaceId, workspaceId)))
            .limit(1)

        if (!proposal) {
            return res.status(404).json({ error: 'Proposal not found' })
        }

        const results = await db.select()
            .from(rsiTestResults)
            .where(eq(rsiTestResults.proposalId, proposalId))
            .orderBy(desc(rsiTestResults.createdAt))
            .limit(50)

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
