// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { runDivergenceCheck } from '@plexo/agent/memory/divergence'
import { logger } from '../../logger.js'

// Operator-triggered parity check between memory_entries and Graphiti.
// Invoked daily during the Phase 5 dual-write observation window per
// graphiti-migration/operator-cutover-runbook.md §5.4–5.5.
export const adminDivergenceRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SAMPLE_SIZE = 200

adminDivergenceRouter.post('/', async (req, res) => {
    const body = (req.body ?? {}) as { workspaceId?: unknown; sampleSize?: unknown }

    if (typeof body.workspaceId !== 'string' || !UUID_RE.test(body.workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'workspaceId must be a UUID string' } })
        return
    }

    let sampleSize: number | undefined
    if (body.sampleSize !== undefined) {
        if (
            typeof body.sampleSize !== 'number' ||
            !Number.isInteger(body.sampleSize) ||
            body.sampleSize < 1 ||
            body.sampleSize > MAX_SAMPLE_SIZE
        ) {
            res.status(400).json({
                error: { code: 'INVALID_BODY', message: `sampleSize must be an integer in [1, ${MAX_SAMPLE_SIZE}]` },
            })
            return
        }
        sampleSize = body.sampleSize
    }

    try {
        const report = await runDivergenceCheck({ workspaceId: body.workspaceId, sampleSize })
        logger.info(
            {
                workspaceId: body.workspaceId,
                sampled: report.sampled,
                missingInGraphiti: report.missingInGraphiti,
                appId: req.serviceContext?.appId,
            },
            'admin.divergence.check'
        )
        res.json(report)
    } catch (err) {
        logger.error({ err, workspaceId: body.workspaceId }, 'POST /admin/divergence failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'divergence check failed' } })
    }
})
