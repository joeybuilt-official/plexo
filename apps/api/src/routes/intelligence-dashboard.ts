// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Intelligence dashboard routes — Phase 5 of the intelligence overhaul.
 *
 * Powers the top-level `/app/intelligence` visibility dashboard. Single
 * page answers "where is my data going?" — provider chain, local
 * service health, inference logs, cost breakdown, live updates.
 *
 *   GET /api/v1/intel-dashboard/:workspaceId/flow
 *   GET /api/v1/intel-dashboard/:workspaceId/health
 *   GET /api/v1/intel-dashboard/:workspaceId/logs?taskType=&model=&from=&to=&limit=
 *   GET /api/v1/intel-dashboard/:workspaceId/cost-summary
 *   GET /api/v1/intel-dashboard/:workspaceId/stream   (SSE)
 *
 * Mounted at a separate path from the Phase 2a+ `intelligenceRouter`
 * (which owns `/api/v1/intelligence/:workspaceId/*`) so the dashboard
 * endpoints don't collide with the workspace-scoped middleware on that
 * router. The spec calls for `/api/v1/intelligence/flow` but the
 * existing router's mount-level `:workspaceId` parameter would capture
 * `flow` as a workspace id and 400. `/intel-dashboard` is the honest
 * collision-free path.
 */

import { Router } from 'express'
import pino from 'pino'
import { db, sql } from '@plexo/db'
import { pgRows } from '../lib/pg-rows.js'
import { requireWorkspaceMember } from '../middleware/workspace-access.js'
import { getWorkspaceSpend } from '../lib/intelligence-spend.js'
import { invalidateIntelligenceSettings } from '../lib/intelligence-cache.js'

const logger = pino({ name: 'intel-dashboard' })
const router: import('express').Router = Router({ mergeParams: true })

router.use('/:workspaceId', requireWorkspaceMember('workspaceId'))

function getWsId(req: any): string | null {
    return (req.params?.workspaceId ?? req.params?.id) ?? null
}

// ── GET /flow ─────────────────────────────────────────────────────────────

router.get('/:workspaceId/flow', async (req: any, res: any) => {
    const workspaceId = getWsId(req)
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })

    try {
        const [providersResult, chainsResult, embeddingsResult, settingsResult] = await Promise.all([
            db.execute(sql`
                SELECT id, provider_type, nickname, enabled, managed, selected_model,
                       embedding_model, embedding_dimensions
                FROM provider_instances
                WHERE workspace_id = ${workspaceId}::uuid
                ORDER BY preference_order, created_at
            `),
            db.execute(sql`
                SELECT task_type, COUNT(*)::int AS length
                FROM routing_chains
                WHERE workspace_id = ${workspaceId}::uuid
                GROUP BY task_type
                ORDER BY task_type
            `),
            db.execute(sql`
                SELECT COUNT(*) FILTER (WHERE embedding_model IS NOT NULL)::int AS embedding_providers,
                       COUNT(*)::int AS total_providers
                FROM provider_instances
                WHERE workspace_id = ${workspaceId}::uuid AND enabled = true
            `),
            db.execute(sql`
                SELECT intelligence_settings AS s
                FROM workspaces
                WHERE id = ${workspaceId}::uuid LIMIT 1
            `),
        ])

        const providerRows = pgRows(providersResult)
            ?? (Array.isArray(providersResult) ? (providersResult as any[]) : [])
        const chainRows = pgRows(chainsResult)
            ?? (Array.isArray(chainsResult) ? (chainsResult as any[]) : [])
        const embeddingsRows = pgRows(embeddingsResult)
            ?? (Array.isArray(embeddingsResult) ? (embeddingsResult as any[]) : [])
        const settingsRows = pgRows(settingsResult)
            ?? (Array.isArray(settingsResult) ? (settingsResult as any[]) : [])

        const settings = (settingsRows?.[0]?.s ?? {}) as Record<string, any>
        const sclBlock = (settings.scl ?? {}) as Record<string, any>
        const memoryBlock = (settings.memory ?? {}) as Record<string, any>

        return res.json({
            providers: (providerRows ?? []).map((p: any) => ({
                id: String(p.id),
                providerType: String(p.provider_type),
                nickname: p.nickname ? String(p.nickname) : null,
                enabled: Boolean(p.enabled),
                managed: Boolean(p.managed),
                selectedModel: p.selected_model ? String(p.selected_model) : null,
                embeddingModel: p.embedding_model ? String(p.embedding_model) : null,
                embeddingDimensions: p.embedding_dimensions ? Number(p.embedding_dimensions) : null,
            })),
            chains: (chainRows ?? []).map((r: any) => ({
                taskType: String(r.task_type),
                length: Number(r.length ?? 0),
            })),
            embeddings: {
                configured: Number(embeddingsRows?.[0]?.embedding_providers ?? 0),
                totalEnabled: Number(embeddingsRows?.[0]?.total_providers ?? 0),
            },
            scl: {
                enabled: typeof sclBlock.enabled === 'boolean' ? sclBlock.enabled : false,
                driftThreshold: typeof sclBlock.driftThreshold === 'number' ? sclBlock.driftThreshold : 0.15,
            },
            memory: {
                evictionEnabled: typeof ((memoryBlock.eviction ?? {}) as any).enabled === 'boolean'
                    ? ((memoryBlock.eviction ?? {}) as any).enabled
                    : false,
            },
            inferenceMode: typeof settings.inferenceMode === 'string' ? settings.inferenceMode : 'auto',
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to load flow state')
        return res.status(500).json({ error: 'Failed to load flow state' })
    }
})

// ── GET /health ───────────────────────────────────────────────────────────

interface ServiceHealth {
    name: string
    status: 'up' | 'down' | 'unknown'
    latencyMs: number | null
    detail: string | null
}

async function probeUrl(name: string, url: string, timeoutMs = 2500): Promise<ServiceHealth> {
    const started = Date.now()
    try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), timeoutMs)
        const res = await fetch(url, { signal: controller.signal, method: 'GET' })
        clearTimeout(t)
        return {
            name,
            status: res.ok ? 'up' : 'down',
            latencyMs: Date.now() - started,
            detail: res.ok ? null : `HTTP ${res.status}`,
        }
    } catch (err: unknown) {
        return {
            name,
            status: 'down',
            latencyMs: Date.now() - started,
            detail: err instanceof Error ? err.message.slice(0, 120) : 'unreachable',
        }
    }
}

router.get('/:workspaceId/health', async (req: any, res: any) => {
    const workspaceId = getWsId(req)
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })

    try {
        const probes: Array<Promise<ServiceHealth>> = []

        // Postgres — quick SELECT 1
        probes.push((async (): Promise<ServiceHealth> => {
            const started = Date.now()
            try {
                await db.execute(sql`SELECT 1`)
                return { name: 'postgres', status: 'up', latencyMs: Date.now() - started, detail: null }
            } catch (err: unknown) {
                return { name: 'postgres', status: 'down', latencyMs: Date.now() - started, detail: (err instanceof Error ? err.message : 'error').slice(0, 120) }
            }
        })())

        // Embeddings server (Phase 0 rename — EMBEDDINGS_URL with legacy fallback)
        const embeddingsUrl = process.env.EMBEDDINGS_URL
            ?? process.env.INFERENCE_GATEWAY_URL
            ?? null
        if (embeddingsUrl) {
            probes.push(probeUrl('embeddings', `${embeddingsUrl.replace(/\/$/, '')}/healthz`))
        } else {
            probes.push(Promise.resolve({
                name: 'embeddings',
                status: 'unknown' as const,
                latencyMs: null,
                detail: 'EMBEDDINGS_URL not set (profile disabled)',
            }))
        }

        // Ollama (optional profile)
        const ollamaUrl = process.env.OLLAMA_URL ?? null
        if (ollamaUrl) {
            probes.push(probeUrl('ollama', `${ollamaUrl.replace(/\/$/, '')}/api/tags`))
        } else {
            probes.push(Promise.resolve({
                name: 'ollama',
                status: 'unknown' as const,
                latencyMs: null,
                detail: 'OLLAMA_URL not set (profile disabled)',
            }))
        }

        // Redis / Valkey via REDIS_URL
        const redisUrl = process.env.REDIS_URL ?? null
        probes.push((async (): Promise<ServiceHealth> => {
            if (!redisUrl) return { name: 'redis', status: 'unknown', latencyMs: null, detail: 'REDIS_URL not set' }
            const started = Date.now()
            try {
                const { createClient } = await import('redis')
                const client = createClient({ url: redisUrl })
                await client.connect()
                await client.ping()
                await client.quit()
                return { name: 'redis', status: 'up', latencyMs: Date.now() - started, detail: null }
            } catch (err: any) {
                return { name: 'redis', status: 'down', latencyMs: Date.now() - started, detail: String(err?.message ?? 'error').slice(0, 120) }
            }
        })())

        const services = await Promise.all(probes)
        return res.json({ services, checkedAt: new Date().toISOString() })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to probe health')
        return res.status(500).json({ error: 'Health probe failed' })
    }
})

// ── GET /logs ─────────────────────────────────────────────────────────────

router.get('/:workspaceId/logs', async (req: any, res: any) => {
    const workspaceId = getWsId(req)
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })

    const taskType = typeof req.query.taskType === 'string' ? req.query.taskType : undefined
    const model = typeof req.query.model === 'string' ? req.query.model : undefined
    const fromStr = typeof req.query.from === 'string' ? req.query.from : undefined
    const toStr = typeof req.query.to === 'string' ? req.query.to : undefined
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100))

    try {
        const taskClause = taskType ? sql`AND il.task_type = ${taskType}` : sql``
        const modelClause = model ? sql`AND il.model = ${model}` : sql``
        const fromClause = fromStr ? sql`AND il.created_at >= ${fromStr}::timestamptz` : sql``
        const toClause = toStr ? sql`AND il.created_at <= ${toStr}::timestamptz` : sql``

        const result = await db.execute(sql`
            SELECT il.id, il.model, il.provider, il.task_type, il.input_tokens,
                   il.output_tokens, il.latency_ms, il.success, il.created_at,
                   mk.cost_per_m_in, mk.cost_per_m_out
            FROM inference_logs il
            LEFT JOIN models_knowledge mk
              ON mk.model_id = il.model AND (il.provider IS NULL OR mk.provider = il.provider)
            WHERE il.workspace_id = ${workspaceId}::uuid
              ${taskClause}
              ${modelClause}
              ${fromClause}
              ${toClause}
            ORDER BY il.created_at DESC
            LIMIT ${limit}
        `)
        const rows = pgRows(result)
            ?? (Array.isArray(result) ? (result as any[]) : [])

        const logs = (rows ?? []).map((r: any) => {
            const inTokens = Number(r.input_tokens ?? 0)
            const outTokens = Number(r.output_tokens ?? 0)
            const inPrice = Number(r.cost_per_m_in ?? 0)
            const outPrice = Number(r.cost_per_m_out ?? 0)
            const cost = (inTokens / 1_000_000) * inPrice + (outTokens / 1_000_000) * outPrice
            return {
                id: String(r.id),
                model: String(r.model),
                provider: r.provider ? String(r.provider) : null,
                taskType: String(r.task_type ?? 'unknown'),
                inputTokens: inTokens,
                outputTokens: outTokens,
                latencyMs: Number(r.latency_ms ?? 0),
                success: Boolean(r.success ?? true),
                costUsd: cost,
                priced: inPrice > 0 || outPrice > 0,
                createdAt: r.created_at,
            }
        })

        return res.json({ logs, total: logs.length })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to load inference logs')
        return res.status(500).json({ error: 'Failed to load logs' })
    }
})

// ── GET /cost-summary ─────────────────────────────────────────────────────

router.get('/:workspaceId/cost-summary', async (req: any, res: any) => {
    const workspaceId = getWsId(req)
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })

    try {
        const spend = await getWorkspaceSpend(workspaceId)

        // Top model + top task type — single round trip with two
        // aggregates priced via the same join as intelligence-spend.ts.
        const monthStart = spend.monthStart
        const breakdownResult = await db.execute(sql`
            WITH priced AS (
                SELECT il.model, il.task_type, il.input_tokens, il.output_tokens,
                       mk.cost_per_m_in, mk.cost_per_m_out
                FROM inference_logs il
                LEFT JOIN models_knowledge mk
                  ON mk.model_id = il.model AND (il.provider IS NULL OR mk.provider = il.provider)
                WHERE il.workspace_id = ${workspaceId}::uuid
                  AND il.created_at >= ${monthStart}::timestamptz
                  AND il.success = true
            ),
            model_totals AS (
                SELECT model,
                       SUM(
                         CASE WHEN cost_per_m_in IS NOT NULL
                              THEN (input_tokens::numeric / 1000000.0) * cost_per_m_in
                              ELSE 0 END
                       + CASE WHEN cost_per_m_out IS NOT NULL
                              THEN (output_tokens::numeric / 1000000.0) * cost_per_m_out
                              ELSE 0 END
                       )::float8 AS cost_usd,
                       COUNT(*)::int AS requests
                FROM priced
                GROUP BY model
                ORDER BY cost_usd DESC NULLS LAST
                LIMIT 1
            ),
            task_totals AS (
                SELECT task_type,
                       SUM(
                         CASE WHEN cost_per_m_in IS NOT NULL
                              THEN (input_tokens::numeric / 1000000.0) * cost_per_m_in
                              ELSE 0 END
                       + CASE WHEN cost_per_m_out IS NOT NULL
                              THEN (output_tokens::numeric / 1000000.0) * cost_per_m_out
                              ELSE 0 END
                       )::float8 AS cost_usd,
                       COUNT(*)::int AS requests
                FROM priced
                GROUP BY task_type
                ORDER BY cost_usd DESC NULLS LAST
                LIMIT 1
            )
            SELECT
                (SELECT model FROM model_totals) AS top_model,
                (SELECT cost_usd FROM model_totals) AS top_model_cost,
                (SELECT requests FROM model_totals) AS top_model_requests,
                (SELECT task_type FROM task_totals) AS top_task_type,
                (SELECT cost_usd FROM task_totals) AS top_task_cost,
                (SELECT requests FROM task_totals) AS top_task_requests
        `)
        const breakdownRows = pgRows(breakdownResult)
            ?? (Array.isArray(breakdownResult) ? (breakdownResult as any[]) : [])
        const row = breakdownRows?.[0] ?? {}

        return res.json({
            spend,
            topModel: row.top_model ? {
                model: String(row.top_model),
                costUsd: Number(row.top_model_cost ?? 0),
                requests: Number(row.top_model_requests ?? 0),
            } : null,
            topTaskType: row.top_task_type ? {
                taskType: String(row.top_task_type),
                costUsd: Number(row.top_task_cost ?? 0),
                requests: Number(row.top_task_requests ?? 0),
            } : null,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to load cost summary')
        return res.status(500).json({ error: 'Failed to load cost summary' })
    }
})

// ── GET /stream (SSE) ─────────────────────────────────────────────────────
//
// Minimal server-sent events stream. Polls the priced spend + recent
// log count every 3s and emits a single heartbeat with the snapshot.
// The client EventSource reconnects automatically on disconnect.
// This is NOT a full change-feed — it's a cheap refresh trigger for
// the dashboard that keeps the implementation small.

router.get('/:workspaceId/stream', async (req: any, res: any) => {
    const workspaceId = getWsId(req)
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })
    const wsIdNonNull: string = workspaceId

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    let closed = false
    const iv = setInterval(tick, 3000)
    req.on('close', () => { closed = true; clearInterval(iv) })

    async function tick(): Promise<void> {
        if (closed) return
        try {
            const spend = await getWorkspaceSpend(wsIdNonNull)
            const recentResult = await db.execute(sql`
                SELECT COUNT(*)::int AS n
                FROM inference_logs
                WHERE workspace_id = ${wsIdNonNull}::uuid
                  AND created_at >= NOW() - INTERVAL '60 seconds'
            `)
            const recentRows = pgRows(recentResult)
                ?? (Array.isArray(recentResult) ? (recentResult as any[]) : [])
            const recentCount = Number(recentRows?.[0]?.n ?? 0)

            const payload = JSON.stringify({
                pricedUsd: spend.pricedUsd,
                requests: spend.requests,
                recentCount,
                at: new Date().toISOString(),
            })
            res.write(`event: tick\ndata: ${payload}\n\n`)
        } catch (err) {
            logger.error({ err, workspaceId }, 'SSE tick failed')
            if (!closed) {
                res.write(`event: error\ndata: ${JSON.stringify({ code: 'TICK_FAILED', at: new Date().toISOString() })}\n\n`)
            }
        }
    }

    // Immediate first tick, then every 3s.
    await tick()
})

// ── GET /detect (Phase 6 — first-run wizard) ─────────────────────────────
//
// Probes available services + provider keys so the wizard can render
// "what's configured vs what's missing" in one round trip. Reuses the
// same probe helpers as /health but adds provider-key inventory and the
// current firstRunPending flag so the wizard can short-circuit when the
// workspace is already onboarded.

router.get('/:workspaceId/detect', async (req: any, res: any) => {
    const workspaceId = getWsId(req)
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })

    try {
        const embeddingsUrl = process.env.EMBEDDINGS_URL ?? process.env.INFERENCE_GATEWAY_URL ?? null
        const ollamaUrl = process.env.OLLAMA_URL ?? null

        const [providersResult, settingsResult, embeddingsProbe, ollamaProbe, postgresProbe] = await Promise.all([
            db.execute(sql`
                SELECT id, provider_type, nickname, enabled, managed,
                       embedding_model, selected_model
                FROM provider_instances
                WHERE workspace_id = ${workspaceId}::uuid
                ORDER BY preference_order, created_at
            `),
            db.execute(sql`
                SELECT intelligence_settings AS s
                FROM workspaces
                WHERE id = ${workspaceId}::uuid LIMIT 1
            `),
            embeddingsUrl
                ? probeUrl('embeddings', `${embeddingsUrl.replace(/\/$/, '')}/healthz`)
                : Promise.resolve<ServiceHealth>({ name: 'embeddings', status: 'unknown', latencyMs: null, detail: 'EMBEDDINGS_URL not set' }),
            ollamaUrl
                ? probeUrl('ollama', `${ollamaUrl.replace(/\/$/, '')}/api/tags`)
                : Promise.resolve<ServiceHealth>({ name: 'ollama', status: 'unknown', latencyMs: null, detail: 'OLLAMA_URL not set' }),
            (async (): Promise<ServiceHealth> => {
                const started = Date.now()
                try {
                    await db.execute(sql`SELECT 1`)
                    return { name: 'postgres', status: 'up', latencyMs: Date.now() - started, detail: null }
                } catch (err: any) {
                    return { name: 'postgres', status: 'down', latencyMs: Date.now() - started, detail: String(err?.message ?? 'error').slice(0, 120) }
                }
            })(),
        ])

        const providerRows = pgRows(providersResult)
            ?? (Array.isArray(providersResult) ? (providersResult as any[]) : [])
        const settingsRows = pgRows(settingsResult)
            ?? (Array.isArray(settingsResult) ? (settingsResult as any[]) : [])
        const settings = (settingsRows?.[0]?.s ?? {}) as Record<string, any>

        const providers = (providerRows ?? []).map((p: any) => ({
            id: String(p.id),
            providerType: String(p.provider_type),
            nickname: p.nickname ? String(p.nickname) : null,
            enabled: Boolean(p.enabled),
            managed: Boolean(p.managed),
            hasEmbeddingModel: !!p.embedding_model,
            hasChatModel: !!p.selected_model,
        }))

        const enabledProviders = providers.filter(p => p.enabled)
        const embeddingProviders = enabledProviders.filter(p => p.hasEmbeddingModel)
        const chatProviders = enabledProviders.filter(p => p.hasChatModel)

        // pgvector availability — only true if we can confirm postgres is up.
        // Detail-level pgvector probing is left as a future enhancement;
        // the migration baseline assumes the extension is installed.
        const pgvector: ServiceHealth = {
            name: 'pgvector',
            status: postgresProbe.status === 'up' ? 'up' : postgresProbe.status,
            latencyMs: postgresProbe.latencyMs,
            detail: postgresProbe.status === 'up' ? null : postgresProbe.detail,
        }

        return res.json({
            services: {
                postgres: postgresProbe,
                pgvector,
                embeddings: embeddingsProbe,
                ollama: ollamaProbe,
            },
            providers: {
                total: providers.length,
                enabled: enabledProviders.length,
                withEmbedding: embeddingProviders.length,
                withChat: chatProviders.length,
                items: providers,
            },
            current: {
                inferenceMode: typeof settings.inferenceMode === 'string' ? settings.inferenceMode : 'auto',
                costCeilingUsd: typeof settings.costCeilingUsd === 'number' ? settings.costCeilingUsd : null,
                sclEnabled: typeof settings.scl?.enabled === 'boolean' ? settings.scl.enabled : false,
                firstRunPending: settings.firstRunPending !== false,
            },
            recommendations: {
                embeddingsProvider: embeddingsProbe.status === 'up'
                    ? 'local'
                    : (embeddingProviders[0]?.providerType ?? null),
                inferenceMode: 'auto',
                sclEnabled: false,
                costCeilingUsd: 20,
            },
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to run detect probe')
        return res.status(500).json({ error: 'Detect probe failed' })
    }
})

// ── POST /wizard/complete ─────────────────────────────────────────────────
//
// Flips intelligence_settings.firstRunPending to false. Idempotent — a
// second call after the wizard is already done is a no-op success. Cache
// is busted so the dashboard immediately stops showing the banner.

router.post('/:workspaceId/wizard/complete', async (req: any, res: any) => {
    const workspaceId = getWsId(req)
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' })

    try {
        await db.execute(sql`
            UPDATE workspaces
            SET intelligence_settings = jsonb_set(
                COALESCE(intelligence_settings, '{}'::jsonb),
                '{firstRunPending}',
                'false'::jsonb,
                true
            )
            WHERE id = ${workspaceId}::uuid
        `)
        invalidateIntelligenceSettings(workspaceId)
        return res.json({ ok: true, firstRunPending: false })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to mark wizard complete')
        return res.status(500).json({ error: 'Failed to mark wizard complete' })
    }
})

export { router as intelligenceDashboardRouter }
