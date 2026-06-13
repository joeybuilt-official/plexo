// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Model Foundry admin API routes.
 *
 * GET  /api/v1/foundry/models         — list all foundry models
 * GET  /api/v1/foundry/buckets        — domain bucket stats
 * POST /api/v1/foundry/models/:id/promote — confirm promotion (one-way door)
 * POST /api/v1/foundry/models/:id/retire  — reject/retire a model
 * POST /api/v1/foundry/train/:bucket     — manually trigger training
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express'
import * as foundryRepo from '../repositories/foundry.repository.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const foundryRouter: RouterType = Router()

// GET /models
foundryRouter.get('/models', async (_req: Request, res: Response) => {
    try {
        const rows = await foundryRepo.listModels()
        res.json({ models: rows })
    } catch (err) {
        logger.error({ err }, 'Failed to list foundry models')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list models' } })
    }
})

// GET /buckets
foundryRouter.get('/buckets', async (_req: Request, res: Response) => {
    try {
        const { getBucketStats } = await import('@plexo/agent/foundry')
        const stats = await getBucketStats()
        res.json({ buckets: stats })
    } catch (err) {
        logger.error({ err }, 'Failed to get bucket stats')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get bucket stats' } })
    }
})

// POST /models/:id/promote
foundryRouter.post('/models/:id/promote', async (req: Request, res: Response) => {
    const modelId = String(req.params.id ?? '')
    if (!UUID_RE.test(modelId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    try {
        const { promoteModel } = await import('@plexo/agent/foundry')
        await promoteModel(modelId)
        res.json({ ok: true, status: 'promoted' })
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Promotion failed'
        logger.error({ err, modelId }, 'Model promotion failed')
        res.status(400).json({ error: { code: 'PROMOTE_FAILED', message } })
    }
})

// POST /models/:id/retire
foundryRouter.post('/models/:id/retire', async (req: Request, res: Response) => {
    const modelId = String(req.params.id ?? '')
    if (!UUID_RE.test(modelId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    try {
        const { retireModel } = await import('@plexo/agent/foundry')
        await retireModel(modelId)
        res.json({ ok: true, status: 'retired' })
    } catch (err) {
        logger.error({ err, modelId }, 'Model retirement failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Retirement failed' } })
    }
})

// POST /train/:bucket
foundryRouter.post('/train/:bucket', async (req: Request, res: Response) => {
    const bucket = String(req.params.bucket)
    if (!bucket || bucket.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(bucket)) {
        res.status(400).json({ error: { code: 'INVALID_BUCKET', message: 'bucket must be alphanumeric (max 100 chars)' } })
        return
    }
    const { baseModel, workspaceId } = req.body as { baseModel?: string; workspaceId?: string }
    if (workspaceId && !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }

    try {
        const { createFoundryModel, FOUNDRY_DEFAULTS } = await import('@plexo/agent/foundry')
        const { extractTrainingData } = await import('@plexo/agent/foundry')

        const data = await extractTrainingData(bucket, 1)
        if (data.length === 0) {
            res.status(400).json({ error: { code: 'NO_DATA', message: `No training data for bucket "${bucket}"` } })
            return
        }

        const modelId = await createFoundryModel(
            bucket,
            baseModel ?? FOUNDRY_DEFAULTS.BASE_MODEL,
            data.length,
            workspaceId,
        )

        res.json({ ok: true, modelId, status: 'pending', message: 'Model created. Training will start when a provider is configured.' })
    } catch (err) {
        logger.error({ err, bucket }, 'Manual training trigger failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Training trigger failed' } })
    }
})
