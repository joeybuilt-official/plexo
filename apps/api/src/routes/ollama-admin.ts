// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Admin endpoints for the managed Ollama sidecar.
 *
 * These are operator-only. They become user-facing in Phase 6
 * via the Intelligence page. For now, they require the workspace
 * to be owned by a super-admin or the authenticated user.
 *
 * The managed Ollama instance is reachable at OLLAMA_INTERNAL_URL
 * (defaults to http://ollama:11434 inside Docker).
 */

import { Router, type Router as RouterType } from 'express'
import pino from 'pino'
import { classifyModel, getEmbeddingDimensions } from '@plexo/agent/ollama/classify-model'

const logger = pino({ name: 'ollama-admin' })
const router: RouterType = Router()

function getOllamaUrl(): string {
    return process.env.OLLAMA_INTERNAL_URL || 'http://ollama:11434'
}

// ── GET /status ─────────────────────────────────────────────────

router.get('/status', async (_req, res) => {
    const baseUrl = getOllamaUrl()
    try {
        const tagsRes = await fetch(`${baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(5000),
        })

        if (!tagsRes.ok) {
            return res.json({ healthy: false, error: `Ollama returned ${tagsRes.status}`, models: [] })
        }

        const data = await tagsRes.json() as { models: Array<{ name: string; size: number; modified_at: string }> }
        const models = data.models.map(m => ({
            name: m.name,
            sizeMb: Math.round(m.size / 1024 / 1024),
            lastModified: m.modified_at,
            capability: classifyModel(m.name),
            embeddingDimensions: getEmbeddingDimensions(m.name),
        }))

        return res.json({
            healthy: true,
            url: baseUrl,
            modelCount: models.length,
            models,
        })
    } catch (err) {
        logger.warn({ err, baseUrl }, 'Ollama status check failed')
        return res.json({
            healthy: false,
            url: baseUrl,
            error: err instanceof Error ? err.message : 'Connection failed',
            models: [],
        })
    }
})

// ── GET /models ─────────────────────────────────────────────────

router.get('/models', async (_req, res) => {
    const baseUrl = getOllamaUrl()
    try {
        const tagsRes = await fetch(`${baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(5000),
        })
        if (!tagsRes.ok) return res.status(502).json({ error: `Ollama returned ${tagsRes.status}` })

        const data = await tagsRes.json() as {
            models: Array<{
                name: string
                size: number
                modified_at: string
                details?: { parameter_size?: string; quantization_level?: string; family?: string }
            }>
        }

        const models = data.models.map(m => ({
            name: m.name,
            sizeMb: Math.round(m.size / 1024 / 1024),
            lastModified: m.modified_at,
            capability: classifyModel(m.name),
            embeddingDimensions: getEmbeddingDimensions(m.name),
            parameterSize: m.details?.parameter_size ?? null,
            quantization: m.details?.quantization_level ?? null,
            family: m.details?.family ?? null,
        }))

        return res.json({ models })
    } catch (err) {
        logger.error({ err, baseUrl }, 'Ollama models list failed')
        return res.status(502).json({ error: 'Ollama unreachable' })
    }
})

// ── POST /models/pull ───────────────────────────────────────────

const OLLAMA_MODEL_RE = /^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?(?::[a-z0-9._-]+)?$/i

router.post('/models/pull', async (req, res) => {
    const { model } = req.body as { model?: string }
    if (!model || typeof model !== 'string') {
        return res.status(400).json({ error: 'model field required' })
    }
    if (!OLLAMA_MODEL_RE.test(model) || model.length > 200) {
        return res.status(400).json({ error: 'Invalid model name format' })
    }

    const baseUrl = getOllamaUrl()
    logger.info({ model }, 'Pulling Ollama model')

    try {
        const pullRes = await fetch(`${baseUrl}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model, stream: true }),
            signal: AbortSignal.timeout(600_000), // 10 min timeout for large models
        })

        if (!pullRes.ok || !pullRes.body) {
            return res.status(502).json({ error: `Ollama pull returned ${pullRes.status}` })
        }

        // Stream progress via SSE
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        })

        const reader = pullRes.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const event = JSON.parse(line)
                    res.write(`data: ${JSON.stringify(event)}\n\n`)
                } catch { logger.debug({ model, line }, 'ollama-pull: skipping malformed SSE line') }
            }
        }

        res.write(`data: ${JSON.stringify({ status: 'complete', model })}\n\n`)
        res.end()
    } catch (err) {
        logger.error({ err, model }, 'Ollama model pull failed')
        if (!res.headersSent) {
            return res.status(502).json({ error: 'Model pull failed' })
        }
        res.write(`data: ${JSON.stringify({ error: 'Model pull failed' })}\n\n`)
        res.end()
    }
})

// ── DELETE /models/:name ────────────────────────────────────────

router.delete('/models/:name', async (req, res) => {
    const model = req.params.name
    if (!model) return res.status(400).json({ error: 'model name required' })
    if (!OLLAMA_MODEL_RE.test(model) || model.length > 200) {
        return res.status(400).json({ error: 'Invalid model name format' })
    }

    const baseUrl = getOllamaUrl()
    logger.info({ model }, 'Deleting Ollama model')

    try {
        const delRes = await fetch(`${baseUrl}/api/delete`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model }),
            signal: AbortSignal.timeout(30_000),
        })

        if (!delRes.ok) {
            return res.status(delRes.status).json({ error: `Ollama delete returned ${delRes.status}` })
        }

        return res.json({ ok: true, deleted: model })
    } catch (err) {
        logger.error({ err, model }, 'Ollama model delete failed')
        return res.status(502).json({ error: 'Ollama unreachable' })
    }
})

// ── POST /test ──────────────────────────────────────────────────

router.post('/test', async (_req, res) => {
    const baseUrl = getOllamaUrl()
    const results: { embedding: unknown; chat: unknown } = { embedding: null, chat: null }

    // Test embedding
    try {
        const start = Date.now()
        const embRes = await fetch(`${baseUrl}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'snowflake-arctic-embed', input: 'test embedding health check' }),
            signal: AbortSignal.timeout(30_000),
        })
        if (!embRes.ok) throw new Error(`HTTP ${embRes.status}`)
        const embData = await embRes.json() as { embeddings: number[][] }
        const dims = embData.embeddings?.[0]?.length ?? 0
        results.embedding = { ok: true, model: 'snowflake-arctic-embed', dimensions: dims, latencyMs: Date.now() - start }
    } catch (err) {
        results.embedding = { ok: false, error: err instanceof Error ? err.message : 'Failed' }
    }

    // Test chat
    try {
        const start = Date.now()
        const chatRes = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama3.2:3b', messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }], stream: false }),
            signal: AbortSignal.timeout(30_000),
        })
        if (!chatRes.ok) throw new Error(`HTTP ${chatRes.status}`)
        const chatData = await chatRes.json() as { message?: { content: string } }
        results.chat = { ok: true, model: 'llama3.2:3b', response: chatData.message?.content?.slice(0, 100), latencyMs: Date.now() - start }
    } catch (err) {
        results.chat = { ok: false, error: err instanceof Error ? err.message : 'Failed' }
    }

    return res.json(results)
})

export default router
