// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo Embeddings Server (formerly inference-gateway)
 *
 * Self-hosted embedding engine using ONNX Runtime. Bundled with Plexo so
 * self-hosters can run a complete embeddings pipeline with no external
 * provider keys. Serves an OpenAI-compatible /v1/embeddings endpoint backed
 * by snowflake-arctic-embed running natively — no Ollama, no external APIs.
 *
 * Endpoints:
 *   GET  /health                 — readiness probe
 *   GET  /v1/models              — list available models
 *   POST /v1/embeddings          — generate embeddings (OpenAI-compatible)
 *   POST /v1/embeddings/reload   — hot-reload a different ONNX model (admin)
 *   GET  /v1/embeddings/metrics  — request metrics
 */

import express from 'express'
import pino from 'pino'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { stat } from 'fs/promises'
import { initEngine, embed, embedBatch, reloadEngine, isReady, getDimensions, getModelName, getLoadTimeMs } from './engine.js'
import { downloadModel } from './download-model.js'
import { recordRequest, getMetrics } from './metrics.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const logger = pino({ name: 'embeddings-server' })

const PORT = parseInt(process.env.PORT || '3001', 10)
const ADMIN_KEY = process.env.INFERENCE_ADMIN_KEY || ''
const MODEL_ID = process.env.EMBEDDING_MODEL || 'Snowflake/snowflake-arctic-embed-s'
const MODEL_DIR = process.env.EMBEDDING_MODEL_DIR || join(__dir, '..', 'models', 'snowflake-arctic-embed-s')
const MODEL_NAME = process.env.EMBEDDING_MODEL_NAME || 'plexo-embed-v1'

const app = express()
app.use(express.json({ limit: '2mb' }))

// ── Health ──────────────────────────────────────────────────────────
//
// Both /health and /healthz exist. /health is the canonical name; /healthz
// is the alias the Phase 6 first-run wizard's /detect probe at
// apps/api/src/routes/intelligence-dashboard.ts:181,463 hits when checking
// if the embeddings server is reachable. Without this alias the wizard
// reports "Local (recommended)" as disabled even when the server is healthy.

app.get(['/health', '/healthz'], (_req, res) => {
    if (!isReady()) {
        res.status(503).json({ status: 'loading', model: MODEL_NAME })
        return
    }
    res.json({
        status: 'ok',
        model: getModelName(),
        dimensions: getDimensions(),
        loadTimeMs: getLoadTimeMs(),
    })
})

// ── Models ──────────────────────────────────────────────────────────

app.get('/v1/models', (_req, res) => {
    res.json({
        object: 'list',
        data: [
            {
                id: getModelName(),
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'plexo',
                permission: [],
                root: MODEL_ID,
                parent: null,
            },
        ],
    })
})

// ── Embeddings ──────────────────────────────────────────────────────

interface EmbeddingRequest {
    input: string | string[]
    model?: string
}

app.post('/v1/embeddings', async (req, res) => {
    if (!isReady()) {
        res.status(503).json({ error: { message: 'Model still loading', type: 'server_error' } })
        return
    }

    try {
        const body = req.body as EmbeddingRequest
        if (!body.input) {
            res.status(400).json({ error: { message: 'Missing "input" field', type: 'invalid_request_error' } })
            return
        }

        const inputs = Array.isArray(body.input) ? body.input : [body.input]
        if (inputs.length === 0) {
            res.status(400).json({ error: { message: '"input" must be non-empty', type: 'invalid_request_error' } })
            return
        }

        // Cap batch size
        if (inputs.length > 128) {
            res.status(400).json({ error: { message: 'Batch size exceeds 128', type: 'invalid_request_error' } })
            return
        }

        const results = await embedBatch(inputs)
        let totalTokens = 0

        const data = results.map((r, i) => {
            totalTokens += r.tokenCount

            // Record metrics per input
            recordRequest({
                inputLength: inputs[i]!.length,
                tokenCount: r.tokenCount,
                latencyMs: r.latencyMs,
                batchSize: inputs.length,
                model: getModelName(),
            })

            return {
                object: 'embedding' as const,
                embedding: r.embedding,
                index: i,
            }
        })

        res.json({
            object: 'list',
            data,
            model: getModelName(),
            usage: {
                prompt_tokens: totalTokens,
                total_tokens: totalTokens,
            },
        })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err }, 'Embedding request failed')
        res.status(500).json({ error: { message: msg, type: 'server_error' } })
    }
})

// ── Admin: Reload model ─────────────────────────────────────────────

app.post('/v1/embeddings/reload', async (req, res) => {
    if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) {
        res.status(401).json({ error: { message: 'Unauthorized', type: 'auth_error' } })
        return
    }

    try {
        const body = req.body as { model_dir?: string; model_name?: string }
        const newDir = body.model_dir || MODEL_DIR
        const newName = body.model_name || MODEL_NAME

        logger.info({ modelDir: newDir, modelName: newName }, 'Reloading embedding model...')

        await reloadEngine({
            modelDir: newDir,
            modelName: newName,
        })

        res.json({
            status: 'reloaded',
            model: getModelName(),
            dimensions: getDimensions(),
            loadTimeMs: getLoadTimeMs(),
        })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err }, 'Model reload failed')
        res.status(500).json({ error: { message: msg, type: 'server_error' } })
    }
})

// ── Admin: Metrics ──────────────────────────────────────────────────

app.get('/v1/embeddings/metrics', (_req, res) => {
    res.json(getMetrics())
})

// ── Startup ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // Ensure model is downloaded
    try {
        await stat(join(MODEL_DIR, 'model.onnx'))
        logger.info({ modelDir: MODEL_DIR }, 'Model files found')
    } catch {
        logger.info({ modelId: MODEL_ID, modelDir: MODEL_DIR }, 'Model not found — downloading...')
        await downloadModel(MODEL_ID, MODEL_DIR)
    }

    // Initialize engine
    await initEngine({
        modelDir: MODEL_DIR,
        modelName: MODEL_NAME,
    })

    // Start server
    app.listen(PORT, '0.0.0.0', () => {
        logger.info({
            port: PORT,
            model: getModelName(),
            dimensions: getDimensions(),
            loadTimeMs: getLoadTimeMs().toFixed(0),
        }, 'Inference gateway listening')
    })
}

main().catch((err) => {
    logger.error({ err }, 'Failed to start inference gateway')
    process.exit(1)
})
