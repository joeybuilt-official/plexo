// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Embeddings routes — collapsed 2026-06-27 (operator panel 5/5).
 *
 * After the BYOK collapse the workspace embedder is locked to the bundled
 * Plexo Inference Gateway (`apps/embeddings/`). The only surface still
 * needed from this router is the local-server health probe + admin reload,
 * which power the Settings → Intelligence → Embeddings "Bundled services"
 * panel.
 *
 *   GET   /api/v1/embeddings/:workspaceId/local/health
 *         → health probe of the bundled local embeddings server
 *   POST  /api/v1/embeddings/:workspaceId/local/reload
 *         → admin: hot-reload a different ONNX model on the local server
 *
 * The pre-collapse routes (provider listing, embedding-model PATCH, re-embed
 * jobs) were removed because every workspace now resolves to the same
 * 384-d gateway adapter; there is no per-workspace pick to mutate.
 */

import { Router } from 'express'
import pino from 'pino'
import { invalidateIntelligenceSettings } from '../lib/intelligence-cache.js'
import { requireWorkspaceMember } from '../middleware/workspace-access.js'

const logger = pino({ name: 'embeddings-routes' })
const router: import('express').Router = Router({ mergeParams: true })

router.use('/:workspaceId', requireWorkspaceMember('workspaceId'))

function resolveLocalServerUrl(): string | null {
    return (
        process.env.EMBEDDINGS_URL ??
        process.env.EMBEDDINGS_SERVER_URL ??
        process.env.INFERENCE_GATEWAY_URL ??
        null
    )
}

function getWorkspaceId(req: any): string | null {
    return (req.params?.workspaceId ?? req.params?.id) ?? null
}

// ── GET local/health ──────────────────────────────────────────────────────

router.get('/:workspaceId/local/health', async (_req: any, res: any) => {
    const url = resolveLocalServerUrl()
    if (!url) {
        return res.json({
            installed: false,
            status: 'not-detected',
            url: null,
            model: null,
            dimensions: null,
            message: 'Set EMBEDDINGS_URL or start the bundled embeddings docker-compose service',
        })
    }

    try {
        const r = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(3000) })
        if (!r.ok) {
            return res.json({
                installed: true,
                status: r.status === 503 ? 'starting' : 'degraded',
                url,
                model: null,
                dimensions: null,
                message: `Local server returned ${r.status}`,
            })
        }
        const body = await r.json() as { status?: string; model?: string; dimensions?: number; loadTimeMs?: number }
        return res.json({
            installed: true,
            status: body.status === 'ok' ? 'healthy' : (body.status ?? 'degraded'),
            url,
            model: body.model ?? null,
            dimensions: body.dimensions ?? null,
            loadTimeMs: body.loadTimeMs ?? null,
        })
    } catch (err) {
        return res.json({
            installed: true,
            status: 'unreachable',
            url,
            model: null,
            dimensions: null,
            message: err instanceof Error ? err.message : 'Network error',
        })
    }
})

// ── POST local/reload ─────────────────────────────────────────────────────

router.post('/:workspaceId/local/reload', async (req: any, res: any) => {
    const url = resolveLocalServerUrl()
    if (!url) return res.status(404).json({ error: 'Local embeddings server not configured' })

    const { model_dir, model_name } = (req.body ?? {}) as { model_dir?: string; model_name?: string }
    try {
        const r = await fetch(`${url.replace(/\/+$/, '')}/v1/embeddings/reload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.INFERENCE_ADMIN_KEY ? { 'x-admin-key': process.env.INFERENCE_ADMIN_KEY } : {}),
            },
            body: JSON.stringify({ model_dir, model_name }),
            signal: AbortSignal.timeout(60_000),
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) return res.status(r.status).json({ error: 'Reload failed', body })

        const workspaceId = getWorkspaceId(req)
        if (workspaceId) invalidateIntelligenceSettings(workspaceId)
        return res.json({ ok: true, ...(body as object) })
    } catch (err) {
        logger.error({ err }, 'Failed to reload embeddings model')
        return res.status(500).json({ error: 'Reload failed' })
    }
})

export { router as embeddingsRouter }
