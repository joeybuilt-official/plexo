// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /vision/ocr — RapidOCR text recognition.
 *
 * Accepts either a base64 payload or a presigned URL, matching the
 * contract Fonto's `ocrImage()` client at
 * `/workspace/fonto/lib/plexo-vision.ts:180` sends today.
 *
 * Phase 4.2 ships CLIP + Faces inference; OCR remains stubbed and
 * surfaces 503 model_unavailable until a follow-up PR plumbs the
 * PaddleOCR PP-OCRv5 (or PP-OCRv4 fallback) ONNX models. Fonto's
 * `processAsset.ts:382` handles this gracefully — assets still ingest
 * with `ocrState=failed` set on the row.
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { childLogger } from '../lib/logger.js'
import { measure } from '../lib/telemetry.js'
import { recognize, OCR_MODEL_ID } from '../models/ocr.js'

const logger = childLogger('routes/ocr')
export const ocrRouter: ExpressRouter = Router()

interface OcrRequest {
    /** Legacy field name — base64 image bytes. */
    image?: string
    /** Fonto's current name — base64 image bytes. */
    imageBase64?: string
    /** Fonto's preferred path — presigned R2 URL the service fetches. */
    imageUrl?: string
    /** ISO-639-1 hint; default 'en'. */
    lang?: string
}

ocrRouter.post('/', async (req: Request, res: Response) => {
    const body = req.body as OcrRequest
    const lang = body.lang ?? 'en'
    // Resolve the image source — fonto sends `imageUrl` from the worker,
    // and `imageBase64` from the synchronous OCR path. Keep `image` for
    // compatibility with the bootstrap PR's earlier shape.
    let image: string | undefined
    if (body.imageBase64) image = body.imageBase64
    else if (body.image) image = body.image
    else if (body.imageUrl) {
        try {
            const resp = await fetch(body.imageUrl, { redirect: 'follow' })
            if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching imageUrl`)
            const bytes = Buffer.from(await resp.arrayBuffer())
            image = bytes.toString('base64')
        } catch (err) {
            logger.warn({ err, url: body.imageUrl.slice(0, 120) }, 'OCR imageUrl fetch failed')
            res.status(400).json({
                error: {
                    message: `failed to fetch imageUrl: ${err instanceof Error ? err.message : err}`,
                    type: 'invalid_request_error',
                },
            })
            return
        }
    }
    if (!image) {
        res.status(400).json({
            error: {
                message: 'Provide one of "imageBase64", "imageUrl", or "image"',
                type: 'invalid_request_error',
            },
        })
        return
    }
    try {
        const { lines, modelId } = await measure('ocr', OCR_MODEL_ID, () => recognize(image!, lang))
        res.json({ lines, modelId, computedAt: new Date().toISOString() })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err }, 'OCR inference failed')
        if (msg.includes('not configured')) {
            res.status(503).json({ error: { message: msg, type: 'model_unavailable' } })
        } else {
            res.status(500).json({ error: { message: msg, type: 'server_error' } })
        }
    }
})
