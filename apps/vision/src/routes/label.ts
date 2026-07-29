// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /vision/label — object/scene labelling via the OCR-backing VLM.
 *
 * Accepts the same image-source shapes as /vision/ocr (`imageBase64`,
 * `image`, or `imageUrl`) so Fonto's vision client can reuse its plumbing.
 * Returns `{ labels: string[], modelId, computedAt }`.
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { childLogger } from '../lib/logger.js'
import { measure } from '../lib/telemetry.js'
import { label, LABEL_MODEL_ID } from '../models/label.js'

const logger = childLogger('routes/label')
export const labelRouter: ExpressRouter = Router()

interface LabelRequest {
    image?: string
    imageBase64?: string
    imageUrl?: string
}

labelRouter.post('/', async (req: Request, res: Response) => {
    const body = req.body as LabelRequest
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
            logger.warn({ err, url: body.imageUrl.slice(0, 120) }, 'label imageUrl fetch failed')
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
        const { labels, modelId } = await measure('label', LABEL_MODEL_ID, () => label(image!))
        res.json({ labels, modelId, computedAt: new Date().toISOString() })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err }, 'label inference failed')
        if (msg.includes('not configured')) {
            res.status(503).json({ error: { message: msg, type: 'model_unavailable' } })
        } else {
            res.status(500).json({ error: { message: msg, type: 'server_error' } })
        }
    }
})
