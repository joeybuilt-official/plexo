// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL API (ADR 0008)
 *
 * POST /api/v1/scl/mutate           Append concepts to a workspace's concept graph
 * POST /api/v1/scl/expand           Stimulus-driven concept lookup
 * GET  /api/v1/scl/record/meta      Workspace golden-record metadata
 * POST /api/v1/scl/extract/trigger  Fire-and-forget SCL extraction trigger
 *
 * All routes service-key-gated, matching synthesis/themes precedent.
 */
import { Router, type Router as RouterType } from 'express'
import {
    mutateConceptGraph,
    expandConceptGraph,
    getGoldenRecordMeta,
    triggerSclExtract,
} from '@plexo/agent/memory/scl-query'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

const MAX_CONCEPTS_PER_MUTATE = 50
const MAX_LABEL_LEN = 200
const MAX_TYPE_LEN = 60
const MAX_STIMULUS_LEN = 500

export const sclRouter: RouterType = Router()
sclRouter.use(requireServiceKey)

// ── POST /api/v1/scl/mutate ──────────────────────────────────────────────
sclRouter.post('/mutate', async (req, res) => {
    const body = (req.body ?? {}) as {
        workspaceId?: string
        concepts?: Array<{ label?: string; type?: string }>
        source?: string
    }
    const { workspaceId, concepts, source } = body
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!Array.isArray(concepts) || concepts.length === 0) {
        res.status(400).json({ error: { code: 'INVALID_CONCEPTS', message: 'concepts[] required' } })
        return
    }
    if (concepts.length > MAX_CONCEPTS_PER_MUTATE) {
        res.status(400).json({ error: { code: 'TOO_MANY_CONCEPTS', message: `≤${MAX_CONCEPTS_PER_MUTATE} concepts per call` } })
        return
    }
    const cleaned: Array<{ label: string; type: string }> = []
    for (const c of concepts) {
        const label = typeof c.label === 'string' ? c.label.slice(0, MAX_LABEL_LEN) : ''
        const type = typeof c.type === 'string' ? c.type.slice(0, MAX_TYPE_LEN) : ''
        if (!label.trim() || !type.trim()) continue
        cleaned.push({ label, type })
    }
    if (cleaned.length === 0) {
        res.status(400).json({ error: { code: 'INVALID_CONCEPTS', message: 'No concept had non-empty label+type' } })
        return
    }
    try {
        const result = await mutateConceptGraph(workspaceId, cleaned, source ?? req.serviceContext?.appId ?? 'unknown')
        res.json({ ok: true, ...result })
    } catch (err) {
        logger.error({ err, workspaceId }, 'scl.mutate failed')
        res.status(500).json({ error: { code: 'MUTATE_FAILED', message: 'Failed to mutate concept graph' } })
    }
})

// ── POST /api/v1/scl/expand ──────────────────────────────────────────────
sclRouter.post('/expand', async (req, res) => {
    const body = (req.body ?? {}) as {
        workspaceId?: string
        stimulus?: string
        depth?: number
        width?: number
    }
    const { workspaceId, stimulus, depth, width } = body
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (typeof stimulus !== 'string' || !stimulus.trim()) {
        res.status(400).json({ error: { code: 'INVALID_STIMULUS', message: 'stimulus required' } })
        return
    }
    try {
        const result = await expandConceptGraph(
            workspaceId,
            stimulus.slice(0, MAX_STIMULUS_LEN),
            {
                depth: typeof depth === 'number' ? depth : undefined,
                width: typeof width === 'number' ? width : undefined,
            },
        )
        res.json(result)
    } catch (err) {
        logger.error({ err, workspaceId }, 'scl.expand failed')
        res.status(500).json({ error: { code: 'EXPAND_FAILED', message: 'Failed to expand concept graph' } })
    }
})

// ── GET /api/v1/scl/record/meta?workspaceId=… ───────────────────────────
sclRouter.get('/record/meta', async (req, res) => {
    const workspaceId = String(req.query.workspaceId ?? '')
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const meta = await getGoldenRecordMeta(workspaceId)
        if (!meta) {
            res.json({ enabled: false })
            return
        }
        res.json(meta)
    } catch (err) {
        logger.error({ err, workspaceId }, 'scl.record.meta failed')
        res.status(500).json({ error: { code: 'META_FAILED', message: 'Failed to read golden record meta' } })
    }
})

// ── POST /api/v1/scl/extract/trigger ────────────────────────────────────
sclRouter.post('/extract/trigger', async (req, res) => {
    const body = (req.body ?? {}) as {
        workspaceId?: string
        source?: string
        sourceLogId?: string
    }
    const { workspaceId, source, sourceLogId } = body
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (sourceLogId !== undefined && !UUID_RE.test(sourceLogId)) {
        res.status(400).json({ error: { code: 'INVALID_SOURCE_LOG', message: 'sourceLogId must be a valid UUID' } })
        return
    }
    try {
        const result = await triggerSclExtract(
            workspaceId,
            source ?? req.serviceContext?.appId ?? 'unknown',
            sourceLogId,
        )
        res.json(result)
    } catch (err) {
        logger.error({ err, workspaceId }, 'scl.extract.trigger failed')
        res.status(500).json({ error: { code: 'TRIGGER_FAILED', message: 'Failed to trigger SCL extract' } })
    }
})
