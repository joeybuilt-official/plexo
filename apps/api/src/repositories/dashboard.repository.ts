// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Dashboard analytics data-access repository (read-only).
 *
 * owns the dashboard summary/activity queries (task status
 * counts, cost rollups, step stats, ensemble coverage, recent activity). The
 * route keeps the numeric post-processing and response shaping. All filters are
 * parameterised. Cross-table reads (api_cost_tracking, work_ledger, task_steps)
 * use raw `sql` since they aggregate beyond the drizzle `tasks` model.
 */
import { sql, desc } from 'drizzle-orm'
import { db } from '@plexo/db'
import { tasks } from '@plexo/db'

/** Task counts grouped by status for a workspace. */
export async function getTaskStatusCounts(workspaceId: string): Promise<Array<{ status: string; count: string }>> {
    return db.execute<{ status: string; count: string }>(sql`
        SELECT status, COUNT(*) as count
        FROM tasks
        WHERE workspace_id = ${workspaceId}
        GROUP BY status
    `) as unknown as Array<{ status: string; count: string }>
}

/** Current ISO-week cost accumulator row (api_cost_tracking). */
export async function getWeekCost(workspaceId: string, costCeiling: number): Promise<{ cost_usd: string | null; ceiling_usd: string | null } | undefined> {
    const [row] = await db.execute<{ cost_usd: string | null; ceiling_usd: string | null }>(sql`
        SELECT cost_usd, COALESCE(ceiling_usd, ${costCeiling}) AS ceiling_usd
        FROM api_cost_tracking
        WHERE workspace_id = ${workspaceId}::uuid
          AND week_start = date_trunc('week', NOW())::date
        LIMIT 1
    `)
    return row
}

/** All-time cost sum (work_ledger). */
export async function getAllTimeCost(workspaceId: string): Promise<{ total: string } | undefined> {
    const [row] = await db.execute<{ total: string }>(sql`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM work_ledger
        WHERE workspace_id = ${workspaceId}::uuid
    `)
    return row
}

/** Most recent 5 completed tasks. */
export async function getRecentCompletedTasks(workspaceId: string) {
    return db.select({
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
}

/** Step count + token sum over the last 7 days. */
export async function getWeekStepStats(workspaceId: string): Promise<{ count: string; tokens: string } | undefined> {
    const [row] = await db.execute<{ count: string; tokens: string }>(sql`
        SELECT COUNT(*) as count, COALESCE(SUM(ts.tokens_in + ts.tokens_out), 0)::text as tokens
        FROM task_steps ts
        JOIN tasks t ON t.id = ts.task_id
        WHERE t.workspace_id = ${workspaceId}
          AND ts.created_at > NOW() - INTERVAL '7 days'
    `)
    return row
}

/** Ensemble judge-mode coverage + self-vs-final score delta. */
export async function getEnsembleStats(workspaceId: string): Promise<Array<{ mode: string; count: string; avg_delta: string }>> {
    return db.execute<{ mode: string; count: string; avg_delta: string }>(sql`
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
    `) as unknown as Array<{ mode: string; count: string; avg_delta: string }>
}

/** Recent activity feed (most recent tasks for a workspace). */
export async function getActivity(workspaceId: string, limit: number) {
    return db.select({
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
        .limit(limit)
}
