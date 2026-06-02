// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Generic decision seam (locked decision 3).
 *
 * POST /api/v1/revisions/:id/decision   body: { choice: 'approve'|'reject', actor? }
 *
 * The canonical endpoint every channel's parse() lands on. The web POST body is
 * itself run through webAdapter.parse() (web is a first-class channel, not a
 * special case), then routed through the shared applyDecision handler. Concrete
 * /revisions route to start; a /tasks/:id/decision verdict variant can reuse
 * applyDecision unchanged.
 */

import { Router, type Router as ExpressRouter } from 'express'
import { db, and, eq, inArray, promptRevisions, cronJobs, outcomeRecords } from '@plexo/db'
import { applyDecision, defaultDecisionHandlers } from '../channels/decision.js'
import { webAdapter } from '../channels/adapters/web-adapter.js'
import { logger } from '../logger.js'

// ── Read model for the revision-review UI (first consumer of the seam) ───────

export interface SourceOutcome {
    id: string
    summary: string | null
    automatedOutcome: string | null
    humanVerdict: string | null
}

export interface RevisionRow {
    id: string
    routineId: string
    routineName: string
    version: number
    proposedDiff: string
    rationale: string
    sourceOutcomeIds: string[]
    expiresAt: Date | null
}

export interface RevisionView extends Omit<RevisionRow, 'sourceOutcomeIds'> {
    sourceOutcomes: SourceOutcome[]
}

/** Pure — joins a revision row to its resolved source outcomes. Exported for tests. */
export function buildRevisionView(row: RevisionRow, outcomeById: Map<string, SourceOutcome>): RevisionView {
    const { sourceOutcomeIds, ...rest } = row
    return {
        ...rest,
        sourceOutcomes: sourceOutcomeIds.map((id) => outcomeById.get(id)).filter((o): o is SourceOutcome => !!o),
    }
}

export const revisionDecisionRouter: ExpressRouter = Router()

revisionDecisionRouter.post('/:id/decision', async (req, res) => {
    const revisionId = req.params.id
    const body = (req.body ?? {}) as { choice?: string; actor?: string }

    // Web is a first-class channel: the POST body is parsed by the SAME
    // webAdapter.parse() seam every other channel uses. targetType/targetId are
    // fixed by the route; choice/actor come from the body.
    const intent = webAdapter.parse({
        targetType: 'revision',
        targetId: revisionId,
        choice: body.choice,
        actor: body.actor ?? req.user?.email,
    })

    if (!intent || intent.kind !== 'decision') {
        res.status(400).json({ error: { code: 'INVALID_CHOICE', message: "choice must be 'approve' or 'reject'" } })
        return
    }

    try {
        const { kind: _kind, ...decision } = intent
        const result = await applyDecision(decision, defaultDecisionHandlers)
        // ok=false here is a domain rejection (stale prompt, not pending, …) → 409.
        res.status(result.ok ? 200 : 409).json(result)
    } catch (err) {
        logger.error({ err, revisionId }, 'revision decision failed')
        res.status(500).json({ error: { code: 'DECISION_FAILED', message: 'Internal error' } })
    }
})

/**
 * GET /api/v1/revisions/pending?workspaceId=  — pending prompt revisions for the
 * workspace, each with diff + rationale + resolved source outcomes. Feeds the
 * revision-review UI; the UI posts decisions back to /:id/decision (same seam).
 */
revisionDecisionRouter.get('/pending', async (req, res) => {
    const workspaceId = (req.query as Record<string, string>).workspaceId
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId query param required' } })
        return
    }

    try {
        const rows = (await db
            .select({
                id: promptRevisions.id,
                routineId: promptRevisions.routineId,
                routineName: cronJobs.name,
                version: promptRevisions.version,
                proposedDiff: promptRevisions.proposedDiff,
                rationale: promptRevisions.rationale,
                sourceOutcomeIds: promptRevisions.sourceOutcomeIds,
                expiresAt: promptRevisions.expiresAt,
            })
            .from(promptRevisions)
            .innerJoin(cronJobs, eq(promptRevisions.routineId, cronJobs.id))
            .where(and(eq(cronJobs.workspaceId, workspaceId), eq(promptRevisions.status, 'pending')))) as RevisionRow[]

        const allIds = [...new Set(rows.flatMap((r) => r.sourceOutcomeIds))]
        const outcomeById = new Map<string, SourceOutcome>()
        if (allIds.length > 0) {
            const outcomes = await db
                .select({
                    id: outcomeRecords.id,
                    summary: outcomeRecords.summary,
                    automatedOutcome: outcomeRecords.automatedOutcome,
                    humanVerdict: outcomeRecords.humanVerdict,
                })
                .from(outcomeRecords)
                .where(inArray(outcomeRecords.id, allIds))
            for (const o of outcomes) outcomeById.set(o.id, o)
        }

        res.json({ items: rows.map((r) => buildRevisionView(r, outcomeById)) })
    } catch (err) {
        logger.error({ err, workspaceId }, 'revisions pending list failed')
        res.status(500).json({ error: { code: 'LIST_FAILED', message: 'Internal error' } })
    }
})
