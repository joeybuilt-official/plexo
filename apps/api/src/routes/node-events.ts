// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Node Events API
 *
 * POST /api/v1/events         — Emit a local node event
 * GET  /api/v1/events         — Query node events (super-admin)
 * PATCH /api/v1/events/:id/processed — Mark an event processed
 */

import { Router, type Router as RouterType } from 'express'
import { z } from 'zod'
import { logger } from '../logger.js'
import { requireAuth } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/super-admin.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { UUID_RE } from '../validation.js'
import * as nodesRepo from '../repositories/nodes.repository.js'

export const nodeEventsRouter: RouterType = Router()

// ── POST / — emit a local event (service key) ─────────────────────────────────

const emitSchema = z.object({
    eventType: z.string().min(1),
    payload: z.record(z.unknown()).default({}),
    workspaceId: z.string().uuid().optional(),
})

nodeEventsRouter.post('/', requireServiceKey, async (req, res) => {
    try {
        const parsed = emitSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { eventType, payload, workspaceId } = parsed.data
        const selfDid = `did:plexo:${process.env.PLEXO_INSTANCE_ID ?? 'unknown'}`

        const event = await nodesRepo.insertNodeEvent({
            sourceNodeDid: selfDid,
            eventType,
            payload,
            workspaceId: workspaceId ?? null,
            processed: false,
        })

        logger.info({ event: 'node_event_emitted', eventType }, 'Local node event emitted')
        return res.json({ ok: true, eventId: event?.id })
    } catch (err) {
        logger.error({ err }, 'POST /api/v1/events failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to emit event' } })
    }
})

// ── GET / — list recent events (super-admin) ──────────────────────────────────

nodeEventsRouter.get('/', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt((req.query.limit as string | undefined) ?? '50', 10), 200)
        const offset = Math.max(parseInt((req.query.offset as string | undefined) ?? '0', 10), 0)
        const processed = req.query.processed === 'true' ? true : req.query.processed === 'false' ? false : undefined

        const rows = await nodesRepo.listNodeEvents({ processed, limit, offset })

        return res.json({ items: rows, total: rows.length, pagination: { limit, offset } })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/events failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list events' } })
    }
})

// ── PATCH /:id/processed — mark event processed ───────────────────────────────

nodeEventsRouter.patch('/:id/processed', requireAuth, requireSuperAdmin, async (req, res) => {
    const id = (req.params as { id: string }).id
    if (!UUID_RE.test(id)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'id must be a UUID' } })
    }

    try {
        const updated = await nodesRepo.markNodeEventProcessed(id)

        if (!updated) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event not found' } })
        }

        return res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'PATCH /api/v1/events/:id/processed failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to mark event processed' } })
    }
})
