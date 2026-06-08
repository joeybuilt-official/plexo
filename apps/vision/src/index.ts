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
 *   POST /v1/faces/detect         — combined detect+embed (Fonto path)
 *   POST /v1/faces/cluster        — GPU cosine-edge builder for clustering
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
import { facesClusterRouter } from './routes/facesCluster.js'
import { ocrRouter } from './routes/ocr.js'
import { labelRouter } from './routes/label.js'

const PORT = parseInt(process.env.PORT ?? '7000', 10)

const app = express()

// 512 MB body cap — images are base64-encoded (inflates ~33%), so a raw
// 12 MB JPEG fits comfortably and the per-image routes only need ~20 MB.
// The headroom is for POST /v1/faces/cluster, which can take up to
// VISION_CLUSTER_MAX_N (default 50 000) 512-d float32 vectors JSON-encoded
// — at N=20 000 that's already ~205 MB. apps/embeddings uses 2 MB for text.
app.use(express.json({ limit: '512mb' }))

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

// GPU-accelerated cosine-edge builder used by Fonto's face clusterer.
// Same /v1/faces prefix + auth as the combined detect+embed route, but
// the heavy lifting (O(N²) cosine matmul over up to 50 k vectors) runs
// on the CUDA EP through a singleton MatMul session
// (apps/vision/src/lib/matmulSession.ts).
app.use('/v1/faces', requireServiceKey, facesClusterRouter)

app.listen(PORT, '0.0.0.0', () => {
    rootLogger.info({ port: PORT }, 'Plexo vision service listening')
})

// Surface unhandled rejections so they get into pino instead of vanishing
// into the default Node handler. Matches apps/embeddings behaviour.
process.on('unhandledRejection', (err) => {
    rootLogger.error({ err }, 'Unhandled promise rejection')
})
