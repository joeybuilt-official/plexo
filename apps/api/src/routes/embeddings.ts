// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Embeddings routes — Phase 1 of the intelligence overhaul.
 *
 * Surfaces every embedding-stack control to the Settings → Intelligence
 * → Embeddings UI:
 *
 *   GET   /api/v1/embeddings/:workspaceId/providers
 *         → per-instance embedding capability + selected model + last-used + dims
 *   PATCH /api/v1/embeddings/:workspaceId/providers/:instanceId/model
 *         → update embedding_model on a provider instance
 *   GET   /api/v1/embeddings/:workspaceId/local/health
 *         → health probe of the bundled local embeddings server
 *   POST  /api/v1/embeddings/:workspaceId/local/reload
 *         → admin: hot-reload a different ONNX model on the local server
 *   POST  /api/v1/embeddings/:workspaceId/reembed
 *         → kick off a re-embed job, returns jobId
 *   GET   /api/v1/embeddings/:workspaceId/reembed/:jobId
 *         → job status (in-memory + persisted last-report)
 *
 * Every PATCH/POST that mutates settings calls
 * `invalidateIntelligenceSettings(workspaceId)` so the executor hot path
 * picks up changes immediately.
 */

import { Router } from 'express'
import pino from 'pino'
import { db, eq, sql } from '@plexo/db'
import { providerInstances, workspaces } from '@plexo/db'
import { invalidateIntelligenceSettings } from '../lib/intelligence-cache.js'
import { requireWorkspaceMember } from '../middleware/workspace-access.js'
import {
    startReembedJob,
    getReembedJob,
    type ReembedJobReport,
} from '../lib/embeddings-reembed.js'
import {
    DEFAULT_EMBEDDING_MODELS,
    EMBEDDING_CAPABLE_PROVIDERS,
} from '@plexo/agent/embeddings/adapters'

const logger = pino({ name: 'embeddings-routes' })
const router: import('express').Router = Router({ mergeParams: true })

// Every route below is workspace-scoped. The membership middleware enforces
// that req.user is a member of req.params.workspaceId before any handler runs.
router.use('/:workspaceId', requireWorkspaceMember('workspaceId'))

// ── Helpers ────────────────────────────────────────────────────────────────

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

// ── GET providers ─────────────────────────────────────────────────────────

router.get('/:workspaceId/providers', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })

    try {
        const rows = await db.select()
            .from(providerInstances)
            .where(eq(providerInstances.workspaceId, workspaceId))

        const items = rows
            .filter(r => r.enabled !== false)
            .map(r => {
                const supports =
                    r.capabilities?.supportsEmbeddings === true ||
                    EMBEDDING_CAPABLE_PROVIDERS.has(r.providerType)
                const defaults = DEFAULT_EMBEDDING_MODELS[r.providerType]
                const selectedModel = r.embeddingModel ?? defaults?.model ?? null
                const dims = r.embeddingDimensions ?? defaults?.dimensions ?? null
                return {
                    instanceId: r.id,
                    providerType: r.providerType,
                    nickname: r.nickname,
                    managed: r.managed,
                    supportsEmbeddings: supports,
                    embeddingModels: r.capabilities?.embeddingModels ?? [],
                    selectedModel,
                    dimensions: dims,
                    embeddingPreferenceOrder: r.embeddingPreferenceOrder,
                    lastUsedAt: r.embeddingLastUsedAt,
                    health: deriveHealth(r),
                }
            })

        return res.json({ providers: items })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to list embedding providers')
        return res.status(500).json({ error: 'Failed to load embedding providers' })
    }
})

function deriveHealth(row: typeof providerInstances.$inferSelect): 'healthy' | 'degraded' | 'broken' | 'unknown' {
    if (row.capabilities?.discoveryError) return 'broken'
    if (!row.lastDiscoveredAt) return 'unknown'
    const ageMs = Date.now() - new Date(row.lastDiscoveredAt).getTime()
    if (ageMs > 30 * 60 * 1000) return 'degraded'
    return 'healthy'
}

// ── PATCH model ────────────────────────────────────────────────────────────

router.patch('/:workspaceId/providers/:instanceId/model', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    const instanceId = req.params?.instanceId as string | undefined
    if (!workspaceId || !instanceId) {
        return res.status(400).json({ error: 'workspaceId and instanceId required' })
    }

    const { model, dimensions } = (req.body ?? {}) as { model?: string; dimensions?: number }
    if (!model || typeof model !== 'string') {
        return res.status(400).json({ error: 'model required' })
    }

    try {
        const [row] = await db.select()
            .from(providerInstances)
            .where(eq(providerInstances.id, instanceId))
            .limit(1)
        if (!row) return res.status(404).json({ error: 'provider instance not found' })
        if (row.workspaceId !== workspaceId) {
            return res.status(403).json({ error: 'workspace mismatch' })
        }

        const defaults = DEFAULT_EMBEDDING_MODELS[row.providerType]
        const dims = typeof dimensions === 'number' ? dimensions : defaults?.dimensions ?? null
        const previousDims = row.embeddingDimensions ?? defaults?.dimensions ?? null

        const [updated] = await db.update(providerInstances)
            .set({
                embeddingModel: model,
                embeddingDimensions: dims,
                updatedAt: new Date(),
            })
            .where(eq(providerInstances.id, instanceId))
            .returning()

        invalidateIntelligenceSettings(workspaceId)

        return res.json({
            ok: true,
            instance: {
                instanceId: updated!.id,
                providerType: updated!.providerType,
                selectedModel: updated!.embeddingModel,
                dimensions: updated!.embeddingDimensions,
            },
            dimensionChanged: previousDims !== null && dims !== null && previousDims !== dims,
            previousDimensions: previousDims,
        })
    } catch (err) {
        logger.error({ err, instanceId }, 'Failed to update embedding model')
        return res.status(500).json({ error: 'Update failed' })
    }
})

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
            message: 'Set EMBEDDINGS_URL or run `docker compose --profile local-embeddings up -d`',
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

// ── POST reembed ──────────────────────────────────────────────────────────

router.post('/:workspaceId/reembed', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })

    const { sinceCreatedAt, batchSize } = (req.body ?? {}) as {
        sinceCreatedAt?: string
        batchSize?: number
    }

    try {
        // Resolve the workspace's current embedding adapter (the *target*).
        const { resolveEmbeddingAdapterAsync } = await import('@plexo/agent/embeddings/router')
        const resolution = await resolveEmbeddingAdapterAsync(workspaceId)
        if (!resolution.adapter) {
            return res.status(400).json({
                error: 'No embedding provider available — configure one before re-embedding',
                detail: resolution.message,
            })
        }

        const report = startReembedJob({
            workspaceId,
            adapter: resolution.adapter,
            sinceCreatedAt: sinceCreatedAt ?? null,
            batchSize: batchSize ?? 100,
        })

        // Persist the in-progress jobId on the workspace so the UI shows
        // resumable state across page reloads.
        await db.execute(sql`
            UPDATE workspaces
            SET intelligence_settings = jsonb_set(
                COALESCE(intelligence_settings, '{}'::jsonb),
                '{reembed,inProgressJobId}',
                ${JSON.stringify(report.jobId)}::jsonb,
                true
            )
            WHERE id = ${workspaceId}::uuid
        `)
        invalidateIntelligenceSettings(workspaceId)

        return res.json({ ok: true, jobId: report.jobId, status: report.status })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to start reembed job')
        return res.status(500).json({ error: 'Failed to start re-embed job' })
    }
})

// ── GET reembed/:jobId ────────────────────────────────────────────────────

router.get('/:workspaceId/reembed/:jobId', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    const jobId = req.params?.jobId as string | undefined
    if (!workspaceId || !jobId) return res.status(400).json({ error: 'workspaceId and jobId required' })

    // Try in-memory first
    const live = getReembedJob(jobId)
    if (live) {
        if (live.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace mismatch' })
        return res.json({ job: live })
    }

    // Fall back to persisted last-report
    try {
        const [row] = await db.select({ settings: workspaces.intelligenceSettings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)
        const settings = (row?.settings ?? {}) as { reembed?: { lastReport?: ReembedJobReport } }
        const report = settings.reembed?.lastReport
        if (!report || report.jobId !== jobId) {
            return res.status(404).json({ error: 'job not found' })
        }
        return res.json({ job: report })
    } catch (err) {
        logger.error({ err, workspaceId, jobId }, 'Failed to read persisted reembed report')
        return res.status(500).json({ error: 'Failed to load job status' })
    }
})

export { router as embeddingsRouter }
