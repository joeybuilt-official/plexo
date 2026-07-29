// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { logger } from '../logger.js'
import { connectedCount } from '../sse-emitter.js'
import * as dashboardRepo from '../repositories/dashboard.repository.js'

export const dashboardRouter: RouterType = Router()

// ── GET /api/dashboard/summary?workspaceId= ──────────────────────────────────
// Single endpoint for all dashboard card data — minimises client round trips.

dashboardRouter.get('/summary', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_RE.test(workspaceId)) {
        res.json({
            agent: { status: 'idle', activeTasks: 0, queuedTasks: 0, connectedClients: 0 },
            tasks: { byStatus: {}, total: 0, recentActivity: [] },
            cost: { total: 0, thisWeek: 0, ceiling: parseFloat(process.env.API_COST_CEILING_USD ?? '10'), percentUsed: 0 },
            steps: { thisWeek: 0, tokensThisWeek: 0 },
        })
        return
    }

    try {
        // Task counts by status
        const statusRows = await dashboardRepo.getTaskStatusCounts(workspaceId)

        const byStatus: Record<string, number> = {}
        for (const row of statusRows) {
            byStatus[row.status] = parseInt(row.count, 10)
        }

        // Cost totals — read from authoritative tables, NOT tasks.cost_usd
        // api_cost_tracking: current ISO week accumulator (same source as Intelligence page)
        // work_ledger: completed_at-based 7d rolling sum for all-time display
        const costCeiling = parseFloat(process.env.API_COST_CEILING_USD ?? '10')
        const weekCostRow = await dashboardRepo.getWeekCost(workspaceId, costCeiling)
        const allTimeCostRow = await dashboardRepo.getAllTimeCost(workspaceId)

        // Most recent activity (last 5 task completions)
        const recentTasks = await dashboardRepo.getRecentCompletedTasks(workspaceId)

        // Total steps run this week
        const stepRows = await dashboardRepo.getWeekStepStats(workspaceId)

        const weekCost = parseFloat(weekCostRow?.cost_usd ?? '0')
        const totalCost = parseFloat(allTimeCostRow?.total ?? '0')

        const running = byStatus['running'] ?? 0
        const queued = byStatus['queued'] ?? 0

        // Ensemble quality coverage — count tasks by judge mode stored in context JSONB
        const ensembleRows = await dashboardRepo.getEnsembleStats(workspaceId)

        const byMode: Record<string, number> = {}
        let avgDelta: number | null = null
        let totalDeltaSum = 0
        let totalDeltaCount = 0
        for (const row of ensembleRows) {
            if (row.mode) {
                byMode[row.mode] = parseInt(row.count, 10)
                if (row.avg_delta != null) {
                    const d = parseFloat(row.avg_delta)
                    const cnt = parseInt(row.count, 10)
                    totalDeltaSum += d * cnt
                    totalDeltaCount += cnt
                }
            }
        }
        if (totalDeltaCount > 0) avgDelta = totalDeltaSum / totalDeltaCount
        const ensembleTotal = Object.values(byMode).reduce((a, b) => a + b, 0)

        res.json({
            agent: {
                status: running > 0 ? 'running' : 'idle',
                activeTasks: running,
                queuedTasks: queued,
                connectedClients: connectedCount(),
            },
            tasks: {
                byStatus,
                total: Object.values(byStatus).reduce((a, b) => a + b, 0),
                recentActivity: recentTasks,
            },
            cost: {
                total: totalCost,
                thisWeek: weekCost,
                ceiling: costCeiling,
                percentUsed: costCeiling > 0 ? Math.min(100, (weekCost / costCeiling) * 100) : 0,
            },
            steps: {
                thisWeek: parseInt(stepRows?.count ?? '0', 10),
                tokensThisWeek: parseInt(stepRows?.tokens ?? '0', 10),
            },
            ensemble: {
                total: ensembleTotal,
                byMode,
                avgDelta,
            },
        })

    } catch (err) {
        logger.error({ err }, 'GET /api/dashboard/summary failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch dashboard data' } })
    }
})

// ── GET /api/dashboard/activity?workspaceId=&limit= ─────────────────────────

dashboardRouter.get('/activity', async (req, res) => {
    const { workspaceId, limit = '20' } = req.query as Record<string, string>
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_RE.test(workspaceId)) {
        res.json({ items: [] })
        return
    }

    try {
        const items = await dashboardRepo.getActivity(workspaceId, Math.min(parseInt(limit, 10) || 20, 100))

        res.json({ items })
    } catch (err) {
        logger.error({ err }, 'GET /api/dashboard/activity failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch activity' } })
    }
})
