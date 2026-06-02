// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Generic decision seam (locked decision 3).
 *
 * POST /api/v1/revisions/:id/decision   body: { choice: 'approve'|'reject', actor? }
 *
 * The canonical endpoint every channel's parse() (and the web revision-review
 * UI) lands on. Builds a DecisionIntent and routes it through the shared
 * applyDecision handler. Concrete /revisions route to start; a /tasks/:id/
 * decision verdict variant can reuse applyDecision unchanged.
 */

import { Router, type Router as ExpressRouter } from 'express'
import { applyDecision, defaultDecisionHandlers } from '../channels/decision.js'
import type { DecisionChoice } from '../channels/types.js'
import { logger } from '../logger.js'

export const revisionDecisionRouter: ExpressRouter = Router()

revisionDecisionRouter.post('/:id/decision', async (req, res) => {
    const revisionId = req.params.id
    const body = (req.body ?? {}) as { choice?: string; actor?: string }
    const choice = body.choice

    if (choice !== 'approve' && choice !== 'reject') {
        res.status(400).json({ error: { code: 'INVALID_CHOICE', message: "choice must be 'approve' or 'reject'" } })
        return
    }

    const actor = body.actor ?? req.user?.email ?? 'web'

    try {
        const result = await applyDecision(
            { targetType: 'revision', targetId: revisionId, choice: choice as DecisionChoice, actor },
            defaultDecisionHandlers,
        )
        // ok=false here is a domain rejection (stale prompt, not pending, …) → 409.
        res.status(result.ok ? 200 : 409).json(result)
    } catch (err) {
        logger.error({ err, revisionId }, 'revision decision failed')
        res.status(500).json({ error: { code: 'DECISION_FAILED', message: 'Internal error' } })
    }
})
