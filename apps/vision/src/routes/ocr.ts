// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /vision/ocr — RapidOCR text recognition.
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { childLogger } from '../lib/logger.js'
import { measure } from '../lib/telemetry.js'
import { recognize, OCR_MODEL_ID } from '../models/ocr.js'

const logger = childLogger('routes/ocr')
export const ocrRouter: ExpressRouter = Router()

interface OcrRequest {
    image?: string
    lang?: string
}

ocrRouter.post('/', async (req: Request, res: Response) => {
    const body = req.body as OcrRequest
    if (!body?.image) {
        res.status(400).json({ error: { message: 'Missing "image" field', type: 'invalid_request_error' } })
        return
    }
    const lang = body.lang ?? 'en'
    try {
        const { lines, modelId } = await measure('ocr', OCR_MODEL_ID, () => recognize(body.image!, lang))
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
