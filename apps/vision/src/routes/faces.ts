// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /vision/faces/detect — bbox + confidence + landmarks
 * POST /vision/faces/embed  — 512-dim ArcFace vector
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { childLogger } from '../lib/logger.js'
import { measure } from '../lib/telemetry.js'
import { detect, embed } from '../models/faces.js'

const logger = childLogger('routes/faces')
export const facesRouter: ExpressRouter = Router()

interface DetectRequest {
    image?: string
}

interface EmbedRequest {
    image?: string
    bbox?: [number, number, number, number]
}

function badRequest(res: Response, message: string): void {
    res.status(400).json({ error: { message, type: 'invalid_request_error' } })
}

function modelError(res: Response, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Faces inference failed')
    if (msg.includes('not configured')) {
        res.status(503).json({ error: { message: msg, type: 'model_unavailable' } })
    } else {
        res.status(500).json({ error: { message: msg, type: 'server_error' } })
    }
}

facesRouter.post('/detect', async (req: Request, res: Response) => {
    const body = req.body as DetectRequest
    if (!body?.image) return badRequest(res, 'Missing "image" field')
    try {
        const { faces, modelId } = await measure('faces-detect', 'insightface-buffalo_l', () =>
            detect(body.image!),
        )
        res.json({ faces, modelId, computedAt: new Date().toISOString() })
    } catch (err) {
        modelError(res, err)
    }
})

facesRouter.post('/embed', async (req: Request, res: Response) => {
    const body = req.body as EmbedRequest
    if (!body?.image) return badRequest(res, 'Missing "image" field')
    if (body.bbox && (!Array.isArray(body.bbox) || body.bbox.length !== 4)) {
        return badRequest(res, '"bbox" must be [x, y, w, h]')
    }
    try {
        const { vector, modelId } = await measure('faces-embed', 'insightface-buffalo_l', () =>
            embed(body.image!, body.bbox),
        )
        res.json({ vector, modelId, computedAt: new Date().toISOString() })
    } catch (err) {
        modelError(res, err)
    }
})
