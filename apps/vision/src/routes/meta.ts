// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * GET /vision/health — liveness/readiness probe (unauthenticated).
 * GET /vision/models — list known model IDs + load status.
 *
 * Both routes intentionally skip the service-key middleware: docker
 * healthchecks and the apps/api intelligence-dashboard wizard hit these
 * without credentials, same pattern as apps/embeddings /health.
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import * as clip from '../models/clip.js'
import * as faces from '../models/faces.js'
import * as ocr from '../models/ocr.js'
import { summarize } from '../lib/telemetry.js'

export const metaRouter: ExpressRouter = Router()

metaRouter.get('/health', (_req: Request, res: Response) => {
    res.json({
        ok: true,
        models: {
            clip: clip.status(),
            faces: faces.status(),
            ocr: ocr.status(),
        },
    })
})

metaRouter.get('/models', (_req: Request, res: Response) => {
    res.json({
        models: [
            { id: 'openclip-vit-b-32', task: 'clip', dim: clip.CLIP_DIM, status: clip.status()['openclip-vit-b-32'] },
            { id: 'siglip-2', task: 'clip', dim: clip.CLIP_DIM, status: clip.status()['siglip-2'] },
            {
                id: faces.FACES_MODEL_ID,
                task: 'faces',
                dim: faces.FACE_EMBED_DIM,
                status: faces.status(),
            },
            {
                id: ocr.OCR_MODEL_ID,
                task: 'ocr',
                status: ocr.status(),
            },
        ],
        metrics: summarize(),
    })
})
