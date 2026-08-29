// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Intelligence routes — Phase 2a of the intelligence overhaul.
 *
 * Surfaces the workspace-level intelligence settings and current spend
 * to Settings → Intelligence → Routing:
 *
 *   GET   /api/v1/intelligence/:workspaceId/settings
 *   PATCH /api/v1/intelligence/:workspaceId/settings/inference-mode
 *   PATCH /api/v1/intelligence/:workspaceId/settings/cost-ceiling
 *   GET   /api/v1/intelligence/:workspaceId/spend
 *
 * Settings persist to `workspaces.intelligence_settings` JSONB
 * (Phase 0). Every PATCH calls `invalidateIntelligenceSettings(workspaceId)`
 * + `invalidateWorkspaceSpend(workspaceId)` so the executor hot path
 * picks up changes immediately and the spend banner re-renders.
 *
 * Phase 2b adds per-task-type chains and the model catalog browser on
 * top of the same router prefix.
 */

import { Router } from 'express'
import pino from 'pino'
import * as intelligenceRepo from '../repositories/intelligence.repository.js'
import { pgRows } from '../lib/pg-rows.js'
import {
    invalidateIntelligenceSettings,
    type IntelligenceSettings,
} from '../lib/intelligence-cache.js'
import {
    getWorkspaceSpend,
    invalidateWorkspaceSpend,
} from '../lib/intelligence-spend.js'
import { evaluateCostCeiling, clearWarnedWorkspace } from '../middleware/cost-enforcement.js'
import { requireWorkspaceMember } from '../middleware/workspace-access.js'
import {
    ROUTING_TASK_TYPES,
    type RoutingTaskType,
} from '../lib/routing-defaults.js'
import { resetWorkspaceTaskChain } from '../lib/seed-routing-chains.js'

const logger = pino({ name: 'intelligence-routes' })
const router: import('express').Router = Router({ mergeParams: true })

router.use('/:workspaceId', requireWorkspaceMember('workspaceId'))

const INFERENCE_MODES = new Set(['auto', 'byok', 'proxy', 'override', 'auto-economy'])
const COST_MODES = new Set(['soft_warn', 'hard_block', 'off'])

function getWorkspaceId(req: any): string | null {
    return (req.params?.workspaceId ?? req.params?.id) ?? null
}

async function readSettings(workspaceId: string): Promise<IntelligenceSettings> {
    const row = await intelligenceRepo.getIntelligenceSettingsRow(workspaceId)
    return (row?.s ?? {}) as IntelligenceSettings
}

// ── GET settings ──────────────────────────────────────────────────────────

router.get('/:workspaceId/settings', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    if (!workspaceId) return res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })

    try {
        const settings = await readSettings(workspaceId)
        const decision = await evaluateCostCeiling(workspaceId)
        return res.json({
            settings: {
                inferenceMode: settings.inferenceMode ?? 'auto',
                costCeilingUsd: settings.costCeilingUsd ?? null,
                costCeilingMode: settings.costCeilingMode ?? 'soft_warn',
                stepBudget: settings.stepBudget ?? 'normal',
            },
            ceiling: {
                state: decision.state,
                usagePct: decision.usagePct,
                ceilingUsd: decision.ceilingUsd,
            },
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to load intelligence settings')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load settings' } })
    }
})

// ── PATCH inference-mode ──────────────────────────────────────────────────

router.patch('/:workspaceId/settings/inference-mode', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    if (!workspaceId) return res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })

    const { mode } = (req.body ?? {}) as { mode?: string }
    if (!mode || !INFERENCE_MODES.has(mode)) {
        return res.status(400).json({ error: { code: 'INVALID_MODE', message: `mode must be one of: ${Array.from(INFERENCE_MODES).join(', ')}` } })
    }

    try {
        await intelligenceRepo.setInferenceMode(workspaceId, JSON.stringify(mode))
        invalidateIntelligenceSettings(workspaceId)
        return res.json({ ok: true, inferenceMode: mode })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to update inference mode')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── PATCH cost-ceiling ────────────────────────────────────────────────────

router.patch('/:workspaceId/settings/cost-ceiling', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    if (!workspaceId) return res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })

    const body = (req.body ?? {}) as { ceilingUsd?: number | null; mode?: string }
    const { ceilingUsd, mode } = body

    if (ceilingUsd != null && (typeof ceilingUsd !== 'number' || !Number.isFinite(ceilingUsd) || ceilingUsd < 0)) {
        return res.status(400).json({ error: { code: 'INVALID_VALUE', message: 'ceilingUsd must be a non-negative number or null' } })
    }
    if (mode != null && !COST_MODES.has(mode)) {
        return res.status(400).json({ error: { code: 'INVALID_MODE', message: `mode must be one of: ${Array.from(COST_MODES).join(', ')}` } })
    }

    try {
        // Build a single jsonb_set chain — set ceiling first, mode second.
        // null ceilingUsd erases the ceiling (jsonb 'null', which the
        // decision helper treats as no ceiling).
        const ceilingJson = ceilingUsd == null ? 'null' : JSON.stringify(ceilingUsd)
        if (mode != null) {
            await intelligenceRepo.setCostCeilingWithMode(workspaceId, ceilingJson, JSON.stringify(mode))
        } else {
            await intelligenceRepo.setCostCeiling(workspaceId, ceilingJson)
        }

        invalidateIntelligenceSettings(workspaceId)
        invalidateWorkspaceSpend(workspaceId)
        clearWarnedWorkspace(workspaceId)

        return res.json({
            ok: true,
            ceilingUsd: ceilingUsd ?? null,
            mode: mode ?? null,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to update cost ceiling')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── PATCH step-budget ─────────────────────────────────────────────────────

const STEP_BUDGETS = new Set(['conservative', 'normal', 'thorough'])

router.patch('/:workspaceId/settings/step-budget', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    if (!workspaceId) return res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })

    const { budget } = (req.body ?? {}) as { budget?: string }
    if (!budget || !STEP_BUDGETS.has(budget)) {
        return res.status(400).json({ error: { code: 'INVALID_BUDGET', message: `budget must be one of: ${Array.from(STEP_BUDGETS).join(', ')}` } })
    }

    try {
        await intelligenceRepo.setStepBudget(workspaceId, JSON.stringify(budget))
        invalidateIntelligenceSettings(workspaceId)
        return res.json({ ok: true, stepBudget: budget })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to update step budget')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── Chain endpoints (Phase 2b) ────────────────────────────────────────────

const ROUTING_TASK_TYPE_SET = new Set<string>(ROUTING_TASK_TYPES)

function isRoutingTaskType(value: string): value is RoutingTaskType {
    return ROUTING_TASK_TYPE_SET.has(value)
}

interface ChainRow {
    id: string
    task_type: string
    provider_id: string
    model_id: string
    position: number
}

interface ChainEntryView {
    id: string
    providerId: string
    modelId: string
    position: number
}

async function loadChainsForWorkspace(workspaceId: string): Promise<Record<string, ChainEntryView[]>> {
    const result = await intelligenceRepo.selectChainsForWorkspace(workspaceId)
    const rows = pgRows<ChainRow>(result)
    const out: Record<string, ChainEntryView[]> = {}
    for (const tier of ROUTING_TASK_TYPES) out[tier] = []
    for (const row of rows) {
        const tier = row.task_type
        if (!out[tier]) out[tier] = []
        out[tier]!.push({
            id: String(row.id),
            providerId: String(row.provider_id),
            modelId: String(row.model_id),
            position: Number(row.position),
        })
    }
    return out
}

async function invalidateAgentChainCache(workspaceId: string): Promise<void> {
    // The router's chain-resolver lives in @plexo/agent and runs in the
    // same process as the API. Bust its cache via a dynamic import so
    // we don't pull the agent package at module load time.
    try {
        const mod = await import('@plexo/agent/providers/chain-resolver')
        mod.invalidateChainResolver(workspaceId)
    } catch (err) {
        logger.warn({ err, workspaceId }, 'chain-resolver cache invalidation failed (non-fatal)')
    }
}

// GET /:workspaceId/chains
router.get('/:workspaceId/chains', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    if (!workspaceId) return res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
    try {
        const chains = await loadChainsForWorkspace(workspaceId)
        return res.json({ chains, taskTypes: ROUTING_TASK_TYPES })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to load routing chains')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load chains' } })
    }
})

// PATCH /:workspaceId/chains/:taskType — body { entries: [{providerId, modelId}] }
router.patch('/:workspaceId/chains/:taskType', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    const taskType = req.params?.taskType as string | undefined
    if (!workspaceId || !taskType) return res.status(400).json({ error: { code: 'MISSING_PARAMS', message: 'workspaceId + taskType required' } })
    if (!isRoutingTaskType(taskType)) {
        return res.status(400).json({ error: { code: 'INVALID_TASK_TYPE', message: `taskType must be one of: ${Array.from(ROUTING_TASK_TYPES).join(', ')}` } })
    }
    const { entries } = (req.body ?? {}) as { entries?: Array<{ providerId?: string; modelId?: string }> }
    if (!Array.isArray(entries)) {
        return res.status(400).json({ error: { code: 'INVALID_ENTRIES', message: 'entries must be an array' } })
    }
    if (entries.length > 10) {
        return res.status(400).json({ error: { code: 'TOO_MANY_ENTRIES', message: 'chain may not exceed 10 entries' } })
    }
    for (const e of entries) {
        if (!e || typeof e.providerId !== 'string' || typeof e.modelId !== 'string') {
            return res.status(400).json({ error: { code: 'INVALID_ENTRY', message: 'each entry must have providerId + modelId strings' } })
        }
        if (!e.providerId.trim() || !e.modelId.trim()) {
            return res.status(400).json({ error: { code: 'INVALID_ENTRY', message: 'providerId + modelId must be non-empty' } })
        }
    }

    try {
        // Atomic replace: delete existing rows + re-insert in a transaction
        // so a mid-sequence failure doesn't leave a partial chain.
        await intelligenceRepo.replaceChain(workspaceId, taskType, entries as Array<{ providerId: string; modelId: string }>)
        invalidateIntelligenceSettings(workspaceId)
        await invalidateAgentChainCache(workspaceId)
        return res.json({ ok: true, taskType, length: entries.length })
    } catch (err) {
        logger.error({ err, workspaceId, taskType }, 'Failed to write chain')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// POST /:workspaceId/chains/:taskType/reset
router.post('/:workspaceId/chains/:taskType/reset', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    const taskType = req.params?.taskType as string | undefined
    if (!workspaceId || !taskType) return res.status(400).json({ error: { code: 'MISSING_PARAMS', message: 'workspaceId + taskType required' } })
    if (!isRoutingTaskType(taskType)) {
        return res.status(400).json({ error: { code: 'INVALID_TASK_TYPE', message: `taskType must be one of: ${Array.from(ROUTING_TASK_TYPES).join(', ')}` } })
    }
    try {
        const { rowsInserted } = await resetWorkspaceTaskChain(workspaceId, taskType)
        invalidateIntelligenceSettings(workspaceId)
        await invalidateAgentChainCache(workspaceId)
        return res.json({ ok: true, taskType, rowsInserted })
    } catch (err) {
        logger.error({ err, workspaceId, taskType }, 'Failed to reset chain')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Reset failed' } })
    }
})

// ── GET spend ─────────────────────────────────────────────────────────────

router.get('/:workspaceId/spend', async (req: any, res: any) => {
    const workspaceId = getWorkspaceId(req)
    if (!workspaceId) return res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })

    try {
        const [spend, decision] = await Promise.all([
            getWorkspaceSpend(workspaceId),
            evaluateCostCeiling(workspaceId),
        ])
        return res.json({
            spend,
            ceiling: {
                state: decision.state,
                usagePct: decision.usagePct,
                ceilingUsd: decision.ceilingUsd,
            },
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to load spend')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load spend' } })
    }
})

export { router as intelligenceRouter }
