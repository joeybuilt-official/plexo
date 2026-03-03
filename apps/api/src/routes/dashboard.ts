import { Router, type Router as RouterType } from 'express'
import { db, sql, desc } from '@plexo/db'
import { tasks, taskSteps } from '@plexo/db'
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

        // Cost totals
        const costRows = await db.execute<{ total_cost: string; week_cost: string }>(sql`
      SELECT
        COALESCE(SUM(cost_usd), 0)::text as total_cost,
        COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN cost_usd ELSE 0 END), 0)::text as week_cost
      FROM tasks
      WHERE workspace_id = ${workspaceId}
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

        const totalCost = parseFloat(costRows[0]?.total_cost ?? '0')
        const weekCost = parseFloat(costRows[0]?.week_cost ?? '0')
        const costCeiling = parseFloat(process.env.API_COST_CEILING_USD ?? '10')

        const running = byStatus['running'] ?? 0
        const queued = byStatus['queued'] ?? 0

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

    try {
        const items = await db.select().from(tasks)
            .where(sql`workspace_id = ${workspaceId}`)
            .orderBy(desc(tasks.createdAt))
            .limit(Math.min(parseInt(limit, 10) || 20, 100))

        res.json({ items })
    } catch (err) {
        logger.error({ err }, 'GET /api/dashboard/activity failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch activity' } })
    }
})
