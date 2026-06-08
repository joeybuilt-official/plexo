// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Synthesis routes (Phase 8 v1). Public service-key surface for Nexalog's
 * `/app/synthesis` inbox. Suggestions are derived on demand from the
 * cached themes-forest (lib/synthesis.ts) — stateless, no persistence
 * table yet:
 *   - GET  /inbox    — pending suggestions (other statuses → empty)
 *   - POST /:id/accept   — reconstructs the suggestion payload by id
 *   - POST /:id/dismiss  — best-effort ack (client removes optimistically)
 *   - POST /:id/snooze   — best-effort ack
 *   - POST /mute         — best-effort ack (client mute is localStorage)
 *
 * Persistence of dismissed/snoozed/muted state is a follow-up (needs a new
 * drizzle table + migration); the Nexalog client tolerates the no-op acks.
 */

import { Router } from 'express'
import pino from 'pino'
import { isGraphSidecarConfigured } from '../lib/graph-sidecar.js'
import { getForest } from '../lib/forest-service.js'
import { buildSuggestions, acceptedSuggestion } from '../lib/synthesis.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'

const logger = pino({ name: 'synthesis-routes' })
const router: import('express').Router = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

router.use(requireServiceKey)

router.get('/inbox', async (req, res) => {
    const workspaceId = req.query.workspaceId
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE_ID', message: 'workspaceId must be a UUID' } })
        return
    }
    // Only "pending" suggestions are generated; other statuses have no
    // store yet, so return an empty list (the client tolerates this).
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending'
    if (status !== 'pending') {
        res.json({ items: [] })
        return
    }
    if (!isGraphSidecarConfigured()) {
        res.status(503).json({ error: { code: 'SIDECAR_UNCONFIGURED', message: 'graphiti sidecar URL or service key not set' } })
        return
    }
    const kinds = typeof req.query.kinds === 'string' && req.query.kinds.length
        ? req.query.kinds.split(',').map((k) => k.trim()).filter(Boolean)
        : undefined
    const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 15) || 15))
    try {
        const forest = await getForest(workspaceId)
        const items = buildSuggestions(forest, { kinds, limit })
        res.json({ items })
    } catch (err) {
        logger.warn({ workspaceId, err: (err as Error).message }, 'synthesis.inbox: compute failed')
        res.status(502).json({ error: { code: 'SYNTHESIS_ERROR', message: (err as Error).message } })
    }
})

router.post('/mute', (req, res) => {
    // Best-effort: client treats localStorage as canonical for mute.
    res.json({ ok: true })
})

router.post('/:id/accept', async (req, res) => {
    const id = req.params.id
    const workspaceId =
        typeof req.body?.workspaceId === 'string'
            ? req.body.workspaceId
            : typeof req.query.workspaceId === 'string'
              ? req.query.workspaceId
              : ''
    // Accept needs the forest to fill sampleContents/memberIds, but the id
    // carries the label so a page can always be created. If we can't resolve
    // a workspace, still return the id-derived payload.
    if (workspaceId && UUID_RE.test(workspaceId) && isGraphSidecarConfigured()) {
        try {
            const forest = await getForest(workspaceId)
            const accepted = acceptedSuggestion(id, forest)
            if (accepted) {
                res.json(accepted)
                return
            }
        } catch (err) {
            logger.warn({ id, err: (err as Error).message }, 'synthesis.accept: forest lookup failed')
        }
    }
    const fallback = acceptedSuggestion(id, { regions: [], themes: [], subthemes: [], members: [], runId: null, generatedAt: null })
    if (!fallback) {
        res.status(400).json({ error: { code: 'BAD_SUGGESTION_ID', message: 'unrecognized suggestion id' } })
        return
    }
    res.json(fallback)
})

router.post('/:id/dismiss', (req, res) => {
    res.json({ ok: true })
})

router.post('/:id/snooze', (req, res) => {
    res.json({ ok: true })
})

export const synthesisRouter = router
