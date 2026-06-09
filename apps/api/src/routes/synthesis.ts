// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Synthesis routes (Phase 8). Public service-key surface for Nexalog's
 * `/app/synthesis` inbox. Suggestions are computed on demand from the
 * cached themes-forest (lib/synthesis.ts); the user's action on a
 * suggestion is persisted in synthesis_suggestion_state (lib/synthesis-
 * state.ts) so dismissed/snoozed items stop re-surfacing.
 *
 *   - GET  /inbox            — pending (minus suppressed) | snoozed | history
 *   - POST /:id/accept       — page-draft payload; marks accepted
 *   - POST /:id/dismiss      — marks dismissed
 *   - POST /:id/snooze       — marks snoozed N days
 *   - POST /mute             — best-effort ack (client mute is localStorage)
 *
 * dismiss/snooze/accept need workspaceId (the suggestion id doesn't encode
 * it); Nexalog forwards it as a query param.
 */

import { Router } from 'express'
import pino from 'pino'
import { isGraphSidecarConfigured } from '../lib/graph-sidecar.js'
import { getForest } from '../lib/forest-service.js'
import { buildSuggestions, reconstructSuggestion, decodeSuggestionId, type Suggestion } from '../lib/synthesis.js'
import { getSuppressedIds, getByStatus, setState, type SynthStatus } from '../lib/synthesis-state.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'

const logger = pino({ name: 'synthesis-routes' })
const router: import('express').Router = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

router.use(requireServiceKey)

function workspaceFromReq(req: import('express').Request): string {
    const b = (req.body as { workspaceId?: unknown } | undefined)?.workspaceId
    if (typeof b === 'string' && UUID_RE.test(b)) return b
    const q = req.query.workspaceId
    if (typeof q === 'string' && UUID_RE.test(q)) return q
    return ''
}

function kindForId(id: string): string {
    return decodeSuggestionId(id)?.kind ?? 'unknown'
}

router.get('/inbox', async (req, res) => {
    const workspaceId = req.query.workspaceId
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE_ID', message: 'workspaceId must be a UUID' } })
        return
    }
    if (!isGraphSidecarConfigured()) {
        res.status(503).json({ error: { code: 'SIDECAR_UNCONFIGURED', message: 'graphiti sidecar URL or service key not set' } })
        return
    }
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending'
    const kinds = typeof req.query.kinds === 'string' && req.query.kinds.length
        ? req.query.kinds.split(',').map((k) => k.trim()).filter(Boolean)
        : undefined
    const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 15) || 15))

    try {
        const forest = await getForest(workspaceId)

        // Snoozed / dismissed / accepted tabs: reconstruct stored rows.
        if (status === 'snoozed' || status === 'dismissed' || status === 'accepted') {
            const rows = await getByStatus(workspaceId, status as SynthStatus)
            const items = rows
                .map((r) =>
                    reconstructSuggestion(
                        r.suggestionId,
                        forest,
                        status,
                        r.snoozedUntil ? r.snoozedUntil.toISOString() : null
                    )
                )
                .filter((s): s is Suggestion => s !== null)
                .slice(0, limit)
            res.json({ items })
            return
        }

        // Pending: generated suggestions minus anything the user has acted on.
        const suppressed = await getSuppressedIds(workspaceId)
        const items = buildSuggestions(forest, { kinds, limit: limit + suppressed.size }).filter(
            (s) => !suppressed.has(s.id)
        )
        res.json({ items: items.slice(0, limit) })
    } catch (err) {
        logger.warn({ workspaceId, err: (err as Error).message }, 'synthesis.inbox: failed')
        res.status(502).json({ error: { code: 'SYNTHESIS_ERROR', message: (err as Error).message } })
    }
})

router.post('/mute', (req, res) => {
    // Best-effort: client treats localStorage as canonical for mute.
    res.json({ ok: true })
})

router.post('/:id/accept', async (req, res) => {
    const id = req.params.id
    const workspaceId = workspaceFromReq(req)
    let accepted: Suggestion | null = null
    if (workspaceId && isGraphSidecarConfigured()) {
        try {
            const forest = await getForest(workspaceId)
            accepted = reconstructSuggestion(id, forest, 'accepted')
            await setState(workspaceId, id, kindForId(id), 'accepted').catch(() => {})
        } catch (err) {
            logger.warn({ id, err: (err as Error).message }, 'synthesis.accept: forest lookup failed')
        }
    }
    if (!accepted) {
        accepted = reconstructSuggestion(id, { regions: [], themes: [], subthemes: [], members: [], runId: null, generatedAt: null }, 'accepted')
    }
    if (!accepted) {
        res.status(400).json({ error: { code: 'BAD_SUGGESTION_ID', message: 'unrecognized suggestion id' } })
        return
    }
    res.json(accepted)
})

router.post('/:id/dismiss', async (req, res) => {
    const workspaceId = workspaceFromReq(req)
    if (workspaceId) {
        await setState(workspaceId, req.params.id, kindForId(req.params.id), 'dismissed').catch((err) =>
            logger.warn({ id: req.params.id, err: (err as Error).message }, 'synthesis.dismiss: persist failed')
        )
    }
    res.json({ ok: true })
})

router.post('/:id/snooze', async (req, res) => {
    const workspaceId = workspaceFromReq(req)
    const days = Math.max(1, Math.min(60, Number((req.body as { days?: unknown } | undefined)?.days ?? 7) || 7))
    if (workspaceId) {
        const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
        await setState(workspaceId, req.params.id, kindForId(req.params.id), 'snoozed', until).catch((err) =>
            logger.warn({ id: req.params.id, err: (err as Error).message }, 'synthesis.snooze: persist failed')
        )
    }
    res.json({ ok: true, days })
})

export const synthesisRouter = router
