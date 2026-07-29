// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Models routes — Phase 2b of the intelligence overhaul.
 *
 * Surfaces the 506-row models_knowledge catalog to the Settings →
 * Intelligence → Models browser and powers the chain editor's
 * "+ Add model" picker:
 *
 *   GET  /api/v1/models/catalog            — paginated, filterable
 *   GET  /api/v1/models/recommended/:taskType — top picks per task tier
 *   POST /api/v1/models/refresh            — admin only, kicks the syncer
 *
 * Catalog rows pass through `computeModelAttributes` so the response
 * carries the same shape `ModelAttributeBadges` consumes — no
 * client-side recomputation, single source of truth across the API +
 * the chain editor + the catalog browser.
 *
 * The route mounts under `/api/v1/models` (NOT under `/intelligence`)
 * because the catalog is workspace-independent — every workspace sees
 * the same Portkey-sourced rows. Filtering happens client-side via
 * query params, not via workspace scoping.
 */

import { Router } from 'express'
import pino from 'pino'
import * as modelsRepo from '../repositories/models.repository.js'
import { pgRows } from '../lib/pg-rows.js'
import { computeModelAttributes, type ModelAttributes, type ModelKnowledgeInput } from '../lib/model-attributes.js'
import {
    computeDefaultChainsForWorkspace,
    type CatalogModel,
    type EnabledProvider,
    type RoutingTaskType,
    ROUTING_TASK_TYPES,
} from '../lib/routing-defaults.js'
import { requireSuperAdmin } from '../middleware/super-admin.js'

const logger = pino({ name: 'models-routes' })
const router: import('express').Router = Router({ mergeParams: true })

interface CatalogRow {
    id: string
    provider: string
    model_id: string
    context_window: number
    cost_per_m_in: number
    cost_per_m_out: number
    strengths: string[] | null
    reliability_score: number
    last_synced_at: string | Date
}

interface CatalogItemView extends ModelAttributes {
    id: string
    reliabilityScore: number
    lastSyncedAt: string
}

function rowToInput(row: CatalogRow): ModelKnowledgeInput {
    return {
        provider: row.provider,
        modelId: row.model_id,
        contextWindow: Number(row.context_window ?? 128_000),
        costPerMIn: Number(row.cost_per_m_in ?? 0),
        costPerMOut: Number(row.cost_per_m_out ?? 0),
        strengths: Array.isArray(row.strengths) ? row.strengths : [],
    }
}

function rowToView(row: CatalogRow): CatalogItemView {
    const attrs = computeModelAttributes(rowToInput(row))
    return {
        ...attrs,
        id: row.id,
        reliabilityScore: Number(row.reliability_score ?? 1),
        lastSyncedAt: typeof row.last_synced_at === 'string'
            ? row.last_synced_at
            : new Date(row.last_synced_at).toISOString(),
    }
}

// ── GET /catalog ──────────────────────────────────────────────────────────

router.get('/catalog', async (req: any, res: any) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider.slice(0, 50) : undefined
    const rawQ = typeof req.query.q === 'string' ? req.query.q : undefined
    const search = rawQ && rawQ.length <= 100 ? rawQ.toLowerCase() : undefined
    const capability = typeof req.query.capability === 'string' ? req.query.capability.slice(0, 50) : undefined
    const strength = typeof req.query.strength === 'string' ? req.query.strength.slice(0, 50) : undefined
    const costClass = typeof req.query.cost === 'string' ? req.query.cost.slice(0, 20) : undefined
    const latencyClass = typeof req.query.latency === 'string' ? req.query.latency.slice(0, 20) : undefined
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'score'
    const page = Math.max(0, Number(req.query.page ?? 0) || 0)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50) || 50))

    if (page > 1000) {
        return res.status(400).json({ error: 'page must be ≤ 1000' })
    }

    try {
        const result = await modelsRepo.listCatalogOrdered()
        const rows: CatalogRow[] = pgRows(result)
            ?? (Array.isArray(result) ? (result as any[]) : [])

        let items = rows.map(rowToView)

        if (provider) items = items.filter(i => i.provider === provider)
        if (search) {
            items = items.filter(i =>
                i.modelId.toLowerCase().includes(search) ||
                i.provider.toLowerCase().includes(search),
            )
        }
        if (capability) items = items.filter(i => i.capabilities.includes(capability as any))
        if (strength) items = items.filter(i => i.strengths.includes(strength as any))
        if (costClass) items = items.filter(i => i.costClass === costClass)
        if (latencyClass) items = items.filter(i => i.latencyClass === latencyClass)

        // Sort
        if (sort === 'cost') {
            items.sort((a, b) => a.blendedCostPerM - b.blendedCostPerM)
        } else if (sort === 'context') {
            items.sort((a, b) => b.contextWindow - a.contextWindow)
        } else if (sort === 'name') {
            items.sort((a, b) => a.modelId.localeCompare(b.modelId))
        } else {
            // default 'score' — reliability * 100 - cost penalty
            items.sort((a, b) => {
                const sa = a.reliabilityScore * 100 - a.blendedCostPerM
                const sb = b.reliabilityScore * 100 - b.blendedCostPerM
                return sb - sa
            })
        }

        const total = items.length
        const start = page * pageSize
        const slice = items.slice(start, start + pageSize)

        return res.json({
            items: slice,
            total,
            page,
            pageSize,
        })
    } catch (err) {
        logger.error({ err }, 'Failed to load model catalog')
        return res.status(500).json({ error: 'Failed to load catalog' })
    }
})

// ── GET /recommended/:taskType ────────────────────────────────────────────

router.get('/recommended/:taskType', async (req: any, res: any) => {
    const taskType = req.params?.taskType as string | undefined
    if (!taskType || !(ROUTING_TASK_TYPES as readonly string[]).includes(taskType)) {
        return res.status(400).json({ error: `taskType must be one of: ${ROUTING_TASK_TYPES.join(', ')}` })
    }
    try {
        const result = await modelsRepo.listCatalog()
        const rows: CatalogRow[] = pgRows(result)
            ?? (Array.isArray(result) ? (result as any[]) : [])

        // Build a synthetic "all providers enabled" set so the
        // recommendation can pick any catalog model regardless of which
        // providers the workspace has connected. The chain editor still
        // requires the user to pick a real provider; this endpoint is
        // for the catalog browser's "Recommended for {tier}" tab.
        const providers: EnabledProvider[] = []
        const providerMap = new Map<string, string[]>()
        for (const row of rows) {
            if (!providerMap.has(row.provider)) providerMap.set(row.provider, [])
            providerMap.get(row.provider)!.push(row.model_id)
        }
        for (const [providerType, models] of providerMap) {
            providers.push({
                id: `synthetic-${providerType}`,
                providerType,
                enabled: true,
                chatModels: models,
                selectedModel: null,
            })
        }

        const catalog: CatalogModel[] = rows.map((r): CatalogModel => ({
            ...rowToInput(r),
            id: r.id,
            reliabilityScore: Number(r.reliability_score ?? 1),
        }))

        const chains = computeDefaultChainsForWorkspace(providers, catalog)
        const tier = taskType as RoutingTaskType
        const recommended = chains[tier].map((entry) => {
            const row = rows.find(r => r.provider === entry.providerType && r.model_id === entry.modelId)
            if (!row) return null
            return { ...rowToView(row), score: entry.score }
        }).filter(Boolean)

        return res.json({ taskType, recommended })
    } catch (err) {
        logger.error({ err, taskType }, 'Failed to load recommended models')
        return res.status(500).json({ error: 'Failed to load recommended' })
    }
})

// ── POST /refresh (admin) ─────────────────────────────────────────────────

router.post('/refresh', requireSuperAdmin, async (_req: any, res: any) => {
    try {
        const { syncModelKnowledge } = await import('@plexo/agent/providers/knowledge')
        const result = await syncModelKnowledge()
        return res.json({ ok: true, result })
    } catch (err) {
        logger.error({ err }, 'Catalog refresh failed')
        return res.status(500).json({ error: 'Refresh failed' })
    }
})

export { router as modelsRouter }
