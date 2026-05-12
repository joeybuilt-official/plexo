// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, sql, desc } from '@plexo/db'
import { tasks } from '@plexo/db'
import { logger } from '../logger.js'
import { connectedCount } from '../sse-emitter.js'

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
        const statusRows = await db.execute<{ status: string; count: string }>(sql`
      SELECT status, COUNT(*) as count
      FROM tasks
      WHERE workspace_id = ${workspaceId}
      GROUP BY status
    `)

        const byStatus: Record<string, number> = {}
        for (const row of statusRows) {
            byStatus[row.status] = parseInt(row.count, 10)
        }

        // Cost totals — read from authoritative tables, NOT tasks.cost_usd
        // api_cost_tracking: current ISO week accumulator (same source as Intelligence page)
        // work_ledger: completed_at-based 7d rolling sum for all-time display
        const costCeiling = parseFloat(process.env.API_COST_CEILING_USD ?? '10')
        const [weekCostRow] = await db.execute<{ cost_usd: string | null; ceiling_usd: string | null }>(sql`
            SELECT cost_usd, COALESCE(ceiling_usd, ${costCeiling}) AS ceiling_usd
            FROM api_cost_tracking
            WHERE workspace_id = ${workspaceId}::uuid
              AND week_start = date_trunc('week', NOW())::date
            LIMIT 1
        `)
        const [allTimeCostRow] = await db.execute<{ total: string }>(sql`
            SELECT COALESCE(SUM(cost_usd), 0)::text AS total
            FROM work_ledger
            WHERE workspace_id = ${workspaceId}::uuid
        `)

        // Most recent activity (last 5 task completions)
        const recentTasks = await db.select({
            id: tasks.id,
            type: tasks.type,
            status: tasks.status,
            outcomeSummary: tasks.outcomeSummary,
            qualityScore: tasks.qualityScore,
            completedAt: tasks.completedAt,
        }).from(tasks)
            .where(sql`workspace_id = ${workspaceId} AND completed_at IS NOT NULL`)
            .orderBy(desc(tasks.completedAt))
            .limit(5)

        // Total steps run this week
        const stepRows = await db.execute<{ count: string; tokens: string }>(sql`
      SELECT COUNT(*) as count, COALESCE(SUM(ts.tokens_in + ts.tokens_out), 0)::text as tokens
      FROM task_steps ts
      JOIN tasks t ON t.id = ts.task_id
      WHERE t.workspace_id = ${workspaceId}
        AND ts.created_at > NOW() - INTERVAL '7 days'
    `)

        const weekCost = parseFloat(weekCostRow?.cost_usd ?? '0')
        const totalCost = parseFloat(allTimeCostRow?.total ?? '0')

        const running = byStatus['running'] ?? 0
        const queued = byStatus['queued'] ?? 0

        // Ensemble quality coverage — count tasks by judge mode stored in context JSONB
        const ensembleRows = await db.execute<{ mode: string; count: string; avg_delta: string }>(sql`
          SELECT
            context->'_judge'->>'mode' as mode,
            COUNT(*) as count,
            AVG(
              CASE
                WHEN (context->'_judge'->>'selfScore')::float IS NOT NULL
                  AND quality_score IS NOT NULL
                THEN (quality_score - (context->'_judge'->>'selfScore')::float)
              END
            )::text as avg_delta
          FROM tasks
          WHERE workspace_id = ${workspaceId}
            AND status = 'complete'
            AND context ? '_judge'
          GROUP BY context->'_judge'->>'mode'
        `)

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
                thisWeek: parseInt(stepRows[0]?.count ?? '0', 10),
                tokensThisWeek: parseInt(stepRows[0]?.tokens ?? '0', 10),
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
        const items = await db.select({
            id: tasks.id,
            type: tasks.type,
            status: tasks.status,
            source: tasks.source,
            priority: tasks.priority,
            outcomeSummary: tasks.outcomeSummary,
            qualityScore: tasks.qualityScore,
            costUsd: tasks.costUsd,
            createdAt: tasks.createdAt,
            completedAt: tasks.completedAt,
            projectId: tasks.projectId,
        }).from(tasks)
            .where(sql`workspace_id = ${workspaceId}`)
            .orderBy(desc(tasks.createdAt))
            .limit(Math.min(parseInt(limit, 10) || 20, 100))

        res.json({ items })
    } catch (err) {
        logger.error({ err }, 'GET /api/dashboard/activity failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch activity' } })
    }
})
