// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Themes routes (Phase 8). Public service-key surface that Nexalog's
 * `/app/graph` calls for a multi-level thematic forest of the user's
 * workspace knowledge graph. Mirrors routes/graph.ts: requireServiceKey
 * (Bearer + X-App-Id), workspaceId rides the query string. The forest is
 * clustered + cached per workspace by lib/forest-service.ts.
 */

import { Router } from 'express'
import pino from 'pino'
import { isGraphSidecarConfigured } from '../lib/graph-sidecar.js'
import { getForest } from '../lib/forest-service.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'

const logger = pino({ name: 'themes-routes' })
const router: import('express').Router = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

router.use(requireServiceKey)

router.get('/forest', async (req, res) => {
    const workspaceId = req.query.workspaceId
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE_ID', message: 'workspaceId must be a UUID' } })
        return
    }
    if (!isGraphSidecarConfigured()) {
        res.status(503).json({ error: { code: 'SIDECAR_UNCONFIGURED', message: 'graphiti sidecar URL or service key not set' } })
        return
    }
    try {
        const forest = await getForest(workspaceId, req.query.refresh === '1')
        res.json(forest)
    } catch (err) {
        logger.warn({ workspaceId, err: (err as Error).message }, 'themes.forest: compute failed')
        res.status(502).json({ error: { code: 'FOREST_ERROR', message: (err as Error).message } })
    }
})

export const themesRouter = router
