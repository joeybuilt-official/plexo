// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0009 — concept graph endpoints (replaces SCL endpoints).
 *
 * Mounted at /api/v1/graph. All routes require service-key auth (mirrors
 * synthesisRouter / themesRouter precedent).
 *
 *   POST /mutate            upsert concepts + link membership + edge inference
 *   POST /expand            recursive CTE BFS from a stimulus
 *   GET  /meta              counts + last update
 *   POST /extract/trigger   heartbeat; real linker runs in extract-worker
 */

import { Router, type Router as RouterType } from 'express'
import {
    graphMutate,
    graphExpand,
    getGraphMeta,
    triggerGraphExtract,
    type ConceptInput,
} from '@plexo/agent/memory/graph-query'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { UUID_RE } from '../validation.js'
import { logger } from '../logger.js'

export const graphRouter: RouterType = Router()
graphRouter.use(requireServiceKey)

// POST /api/v1/graph/mutate
graphRouter.post('/mutate', async (req, res) => {
    const { workspaceId, concepts, source, memoryEntryId } = (req.body ?? {}) as {
        workspaceId?: string
        concepts?: ConceptInput[]
        source?: string
        memoryEntryId?: string
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!Array.isArray(concepts)) {
        res.status(400).json({ error: { code: 'INVALID_CONCEPTS', message: 'concepts must be an array' } })
        return
    }
    if (!source || typeof source !== 'string') {
        res.status(400).json({ error: { code: 'INVALID_SOURCE', message: 'source required' } })
        return
    }
    if (memoryEntryId && !UUID_RE.test(memoryEntryId)) {
        res.status(400).json({ error: { code: 'INVALID_MEMORY_ENTRY', message: 'memoryEntryId must be a UUID' } })
        return
    }
    try {
        const result = await graphMutate({ workspaceId, concepts, source, memoryEntryId })
        res.json({ ok: true, ...result })
    } catch (err) {
        logger.error({ err, workspaceId }, 'graph.mutate failed')
        res.status(500).json({ error: { code: 'MUTATE_FAILED', message: 'Failed to mutate graph' } })
    }
})

// POST /api/v1/graph/expand
graphRouter.post('/expand', async (req, res) => {
    const { workspaceId, stimulus, depth, width } = (req.body ?? {}) as {
        workspaceId?: string
        stimulus?: string
        depth?: number
        width?: number
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!stimulus || typeof stimulus !== 'string') {
        res.status(400).json({ error: { code: 'INVALID_STIMULUS', message: 'stimulus required' } })
        return
    }
    try {
        const result = await graphExpand({ workspaceId, stimulus, depth, width })
        res.json(result)
    } catch (err) {
        logger.error({ err, workspaceId }, 'graph.expand failed')
        res.status(500).json({ error: { code: 'EXPAND_FAILED', message: 'Failed to expand graph' } })
    }
})

// GET /api/v1/graph/meta?workspaceId=…
graphRouter.get('/meta', async (req, res) => {
    const workspaceId = String(req.query.workspaceId ?? '')
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const meta = await getGraphMeta({ workspaceId })
        res.json({ meta })
    } catch (err) {
        logger.error({ err, workspaceId }, 'graph.meta failed')
        res.status(500).json({ error: { code: 'META_FAILED', message: 'Failed to get graph meta' } })
    }
})

// POST /api/v1/graph/extract/trigger
graphRouter.post('/extract/trigger', async (req, res) => {
    const { workspaceId, sourceLogId } = (req.body ?? {}) as {
        workspaceId?: string
        sourceLogId?: string
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const result = await triggerGraphExtract({ workspaceId, sourceLogId })
        res.json(result)
    } catch (err) {
        logger.error({ err, workspaceId }, 'graph.extract/trigger failed')
        res.status(500).json({ error: { code: 'TRIGGER_FAILED', message: 'Failed to trigger extraction' } })
    }
})
