// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo Vision Service
 *
 * Self-hosted vision pipeline (CLIP image/text, face detection + ArcFace
 * embedding, OCR) served over HTTP. Bundled with Plexo so self-hosters get
 * Immich-parity image intelligence with no external provider keys.
 *
 * Phase 4.1 (per fonto-immich-parity-plan.md): bootstrap. Routes wired,
 * model loaders stubbed with "model not configured" until Phase 4.2 plumbs
 * the real .onnx artifacts + SHA-256 verification.
 *
 * Architecture / model choices: see ADR 0001 — apps/vision (ONNX) instead
 * of a Python sidecar.
 *
 * Endpoints:
 *   GET  /vision/health           — readiness + per-model load status
 *   GET  /vision/models           — model registry + recent latency metrics
 *   POST /vision/clip/image       — image embedding (OpenCLIP / SigLIP-2)
 *   POST /vision/clip/text        — text embedding (same vector space)
 *   POST /vision/faces/detect     — RetinaFace bboxes
 *   POST /vision/faces/embed      — ArcFace 512-dim vector
 *   POST /vision/ocr              — RapidOCR text recognition
 *
 * All POST routes require Authorization: Bearer ${PLEXO_SERVICE_KEY}.
 */

import express from 'express'
import { rootLogger } from './lib/logger.js'
import { requireServiceKey } from './lib/auth.js'
import { metaRouter } from './routes/meta.js'
import { clipRouter } from './routes/clip.js'
import { facesRouter } from './routes/faces.js'
import { facesV1Router } from './routes/faces-v1.js'
import { ocrRouter } from './routes/ocr.js'
import { labelRouter } from './routes/label.js'

const PORT = parseInt(process.env.PORT ?? '7000', 10)

const app = express()

// 20 MB body cap — images are base64-encoded, which inflates ~33%, so a
// raw 12 MB JPEG fits comfortably. apps/embeddings uses 2 MB for text;
// vision needs the headroom for image uploads.
app.use(express.json({ limit: '20mb' }))

// Health + model metadata — unauthenticated, same convention as
// apps/embeddings /health so docker probes work without service keys.
app.use('/vision', metaRouter)

// All inference routes — service-key required.
app.use('/vision/clip', requireServiceKey, clipRouter)
app.use('/vision/faces', requireServiceKey, facesRouter)
app.use('/vision/ocr', requireServiceKey, ocrRouter)
app.use('/vision/label', requireServiceKey, labelRouter)

// Fonto-facing combined detect+embed endpoint. The route prefix is
// `/v1/faces/...` (not `/vision/faces/...`) — Fonto's
// `lib/processing/detectFaces.ts` hits this path directly. Same auth
// gate as the granular routes above.
app.use('/v1/faces', requireServiceKey, facesV1Router)

app.listen(PORT, '0.0.0.0', () => {
    rootLogger.info({ port: PORT }, 'Plexo vision service listening')
})

// Surface unhandled rejections so they get into pino instead of vanishing
// into the default Node handler. Matches apps/embeddings behaviour.
process.on('unhandledRejection', (err) => {
    rootLogger.error({ err }, 'Unhandled promise rejection')
})
