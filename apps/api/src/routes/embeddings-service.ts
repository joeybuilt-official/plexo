// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /api/v1/embeddings/embed
 *
 * Service-facing text-embedding proxy for trusted Joeybuilt apps. Apps get
 * embeddings via Plexo (using the workspace's configured embedding provider
 * credentials) instead of calling OpenAI/Voyage/etc. directly.
 *
 * Auth: PLEXO_SERVICE_KEY via requireServiceKey middleware.
 *
 * Mounted at /api/v1/embeddings BEFORE the workspace-scoped settings router
 * (embeddingsRouter). No collision: this route is a single segment (/embed)
 * while the settings routes are two segments (/:workspaceId/...).
 *
 * Request body:
 *   workspaceId — Plexo workspace UUID (whose embedding creds to use)
 *   input       — string | string[] (non-empty; arrays capped at 64 items)
 *
 * Response (string input):
 *   { embedding: number[], model, dimensions, provider }
 * Response (string[] input):
 *   { embeddings: number[][], model, dimensions, provider }
 */

import { Router, type Router as RouterType } from 'express'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { resolveEmbeddingAdapterAsync } from '@plexo/agent/embeddings/router'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const embeddingsServiceRouter: RouterType = Router()

const MAX_BATCH = 64

embeddingsServiceRouter.post('/embed', requireServiceKey, async (req, res) => {
    const { workspaceId, input } = req.body as {
        workspaceId?: string
        input?: string | string[]
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId UUID required' } })
        return
    }

    const isArray = Array.isArray(input)
    if (isArray) {
        if (input.length === 0) {
            res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'input array must be non-empty' } })
            return
        }
        if (input.length > MAX_BATCH) {
            res.status(400).json({ error: { code: 'INPUT_TOO_LARGE', message: `input array capped at ${MAX_BATCH} items` } })
            return
        }
        for (const item of input) {
            if (typeof item !== 'string' || item.length === 0) {
                res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'every input item must be a non-empty string' } })
                return
            }
        }
    } else if (typeof input !== 'string' || input.length === 0) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'input must be a non-empty string or array of strings' } })
        return
    }

    try {
        const resolution = await resolveEmbeddingAdapterAsync(workspaceId)
        const adapter = resolution.adapter
        if (!adapter) {
            res.status(422).json({
                error: {
                    code: 'NO_EMBEDDING_PROVIDER',
                    message: resolution.message ?? 'No embedding-capable provider configured for this workspace',
                },
            })
            return
        }

        const meta = { model: adapter.model, dimensions: adapter.dimensions, provider: adapter.providerId }

        if (isArray) {
            const embeddings: number[][] = []
            for (const item of input) {
                embeddings.push(await adapter.embed(item))
            }
            res.json({ embeddings, ...meta })
            return
        }

        const embedding = await adapter.embed(input as string)
        res.json({ embedding, ...meta })
    } catch (err) {
        logger.error({ err, workspaceId }, 'POST /api/v1/embeddings/embed failed')
        res.status(500).json({ error: { code: 'EMBEDDING_FAILED', message: 'Embedding generation failed' } })
    }
})
