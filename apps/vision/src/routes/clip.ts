// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /vision/clip/image — image embedding
 * POST /vision/clip/text  — text embedding (same vector space)
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { childLogger } from '../lib/logger.js'
import { measure } from '../lib/telemetry.js'
import { embedImage, embedText, DEFAULT_CLIP_MODEL, type ClipModelId } from '../models/clip.js'

const logger = childLogger('routes/clip')
export const clipRouter: ExpressRouter = Router()

interface ImageRequest {
    image?: string
    modelId?: ClipModelId
}

interface TextRequest {
    text?: string
    modelId?: ClipModelId
}

function badRequest(res: Response, message: string): void {
    res.status(400).json({ error: { message, type: 'invalid_request_error' } })
}

function modelError(res: Response, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'CLIP inference failed')
    // "model not configured" is the bootstrap-phase signal; surface it as
    // 503 so callers can distinguish "service deployed but model missing"
    // from a transient inference failure.
    if (msg.includes('not configured')) {
        res.status(503).json({ error: { message: msg, type: 'model_unavailable' } })
    } else {
        res.status(500).json({ error: { message: msg, type: 'server_error' } })
    }
}

clipRouter.post('/image', async (req: Request, res: Response) => {
    const body = req.body as ImageRequest
    if (!body?.image) return badRequest(res, 'Missing "image" field')
    const modelId = body.modelId ?? DEFAULT_CLIP_MODEL
    try {
        const { vector } = await measure('clip-image', modelId, () =>
            embedImage(body.image!, modelId),
        )
        res.json({ vector, modelId, computedAt: new Date().toISOString() })
    } catch (err) {
        modelError(res, err)
    }
})

clipRouter.post('/text', async (req: Request, res: Response) => {
    const body = req.body as TextRequest
    if (!body?.text || typeof body.text !== 'string') {
        return badRequest(res, 'Missing or non-string "text" field')
    }
    const modelId = body.modelId ?? DEFAULT_CLIP_MODEL
    try {
        const { vector } = await measure('clip-text', modelId, () =>
            embedText(body.text!, modelId),
        )
        res.json({ vector, modelId, computedAt: new Date().toISOString() })
    } catch (err) {
        modelError(res, err)
    }
})
