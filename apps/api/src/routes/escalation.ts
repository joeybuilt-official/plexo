// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 8 — Escalation inbox API.
 *
 * Exposes the per-invocation escalation queue to the UI:
 *
 *   GET  /api/v1/escalations?workspaceId=&status=pending
 *   POST /api/v1/escalations/:id/approve   body { note? }
 *   POST /api/v1/escalations/:id/reject    body { note? }
 *   GET  /api/v1/escalations/stream?workspaceId=
 *
 * All endpoints require workspace membership. The stream endpoint emits
 * ESCALATION_REQUESTED and ESCALATION_DECIDED events over Server-Sent
 * Events so the inbox view refreshes without polling.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express'
import * as escalationRepo from '../repositories/escalation.repository.js'
import { eventBus, TOPICS } from '@plexo/agent/event-bus'
import { approveEscalation, rejectEscalation } from '@plexo/agent/escalation/manager'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const escalationRouter: RouterType = Router()

// ── GET /api/v1/escalations ────────────────────────────────────────────────

escalationRouter.get('/', async (req: Request, res: Response) => {
    const workspaceId = (req.query.workspaceId as string | undefined) ?? req.workspaceId
    const status = (req.query.status as string | undefined) ?? 'pending'

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const rows = await escalationRepo.listEscalations(workspaceId, status)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /escalations failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list escalations' } })
    }
})

// ── POST /api/v1/escalations/:id/approve ───────────────────────────────────

escalationRouter.post('/:id/approve', async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id
    const { note } = (req.body ?? {}) as { note?: string }
    const userId = req.user?.id
    if (!userId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
        return
    }
    if (!id) {
        res.status(400).json({ error: { code: 'MISSING_ID', message: 'escalation id required' } })
        return
    }
    try {
        const decision = await approveEscalation(id, userId, note)
        if (!decision) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Escalation not found or already decided' } })
            return
        }
        res.json(decision)
    } catch (err) {
        logger.error({ err, id }, 'POST /escalations/:id/approve failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve escalation' } })
    }
})

// ── POST /api/v1/escalations/:id/reject ────────────────────────────────────

escalationRouter.post('/:id/reject', async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id
    const { note } = (req.body ?? {}) as { note?: string }
    const userId = req.user?.id
    if (!userId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
        return
    }
    if (!id) {
        res.status(400).json({ error: { code: 'MISSING_ID', message: 'escalation id required' } })
        return
    }
    try {
        const decision = await rejectEscalation(id, userId, note)
        if (!decision) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Escalation not found or already decided' } })
            return
        }
        res.json(decision)
    } catch (err) {
        logger.error({ err, id }, 'POST /escalations/:id/reject failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject escalation' } })
    }
})

// ── GET /api/v1/escalations/stream (SSE) ───────────────────────────────────

escalationRouter.get('/stream', async (req: Request, res: Response) => {
    const workspaceId = (req.query.workspaceId as string | undefined) ?? req.workspaceId
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (event: string, data: unknown) => {
        try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        } catch (err) {
            logger.warn({ err }, 'Escalation SSE write failed')
        }
    }

    send('ready', { ok: true })

    const offRequested = eventBus.subscribe(TOPICS.ESCALATION_REQUESTED, (payload) => {
        const p = payload as { workspaceId?: string }
        if (p?.workspaceId === workspaceId) send('escalation_requested', payload)
    })
    const offDecided = eventBus.subscribe(TOPICS.ESCALATION_DECIDED, (payload) => {
        const p = payload as { workspaceId?: string }
        if (p?.workspaceId === workspaceId) send('escalation_decided', payload)
    })

    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n') } catch { /* socket gone */ }
    }, 15_000)

    req.on('close', () => {
        clearInterval(heartbeat)
        offRequested()
        offDecided()
        try { res.end() } catch { /* already closed */ }
    })
})
