// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Fonto-facing `/v1/faces/detect` route — single combined detect+embed call.
 *
 * Body:   { image: <base64> }
 * Reply:  {
 *           faces: [{
 *             bbox: { x, y, w, h },   // NORMALISED 0..1 of source image
 *             confidence: number,     // 0..1
 *             embedding: number[]     // 512-dim L2-normalised
 *           }],
 *           modelId: string
 *         }
 *
 * This is the shape `/workspace/fonto/lib/processing/detectFaces.ts`
 * consumes today (see audit at PR #48 follow-up). The `/vision/faces/{detect,embed}`
 * routes still exist for fine-grained callers; this combined endpoint is
 * the high-throughput primary path for image-asset ingestion.
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import sharp from 'sharp'
import { childLogger } from '../lib/logger.js'
import { measure } from '../lib/telemetry.js'
import { decodeBase64Input } from '../lib/image.js'
import { detectAndEmbed, FACES_MODEL_ID } from '../models/faces.js'

const logger = childLogger('routes/v1-faces')
export const facesV1Router: ExpressRouter = Router()

interface CombinedRequest {
    image?: string
}

facesV1Router.post('/detect', async (req: Request, res: Response) => {
    const body = req.body as CombinedRequest
    if (!body?.image) {
        res.status(400).json({
            error: { message: 'Missing "image" field', type: 'invalid_request_error' },
        })
        return
    }
    try {
        // We need the source image's dimensions to convert pixel bboxes to
        // normalised 0..1 coordinates. Decoding metadata is cheap (sharp
        // doesn't actually unpack pixels for `.metadata()`).
        const bytes = decodeBase64Input(body.image)
        const meta = await sharp(bytes).metadata()
        const W = meta.width ?? 0
        const H = meta.height ?? 0
        if (W <= 0 || H <= 0) {
            res.status(400).json({
                error: { message: 'Image has invalid dimensions', type: 'invalid_request_error' },
            })
            return
        }
        const result = await measure('faces-detect', FACES_MODEL_ID, () =>
            detectAndEmbed(body.image!),
        )
        const faces = result.faces.map((f) => {
            const [px, py, pw, ph] = f.bbox
            return {
                bbox: {
                    x: Math.max(0, Math.min(1, px / W)),
                    y: Math.max(0, Math.min(1, py / H)),
                    w: Math.max(0, Math.min(1, pw / W)),
                    h: Math.max(0, Math.min(1, ph / H)),
                },
                confidence: f.confidence,
                embedding: f.embedding,
            }
        })
        res.json({ faces, modelId: result.modelId, computedAt: new Date().toISOString() })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err }, '/v1/faces/detect failed')
        if (msg.includes('not configured')) {
            res.status(503).json({ error: { message: msg, type: 'model_unavailable' } })
        } else {
            res.status(500).json({ error: { message: msg, type: 'server_error' } })
        }
    }
})
