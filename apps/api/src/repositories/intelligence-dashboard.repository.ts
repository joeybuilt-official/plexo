// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Intelligence-dashboard data-access repository (read-only + wizard flag).
 *
 * owns the dashboard's flow/health/logs/cost/router-stats
 * queries plus the first-run wizard flag update. The route keeps the pgRows()
 * unwrapping, numeric post-processing, response shaping, service probes
 * (fetch/redis), cache invalidation, and SSE orchestration. All queries are
 * raw `sql` (cross-table aggregates over provider_instances, routing_chains,
 * workspaces, inference_logs, models_knowledge, router_v2_stats) and stay
 * workspace-scoped where the original was. Filters are parameterised.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

/** Liveness ping for the postgres health probe. */
export async function pingPostgres(): Promise<void> {
    await db.execute(sql`SELECT 1`)
}

/** Provider instances for the flow view (ordered by preference). */
export async function getFlowProviders(workspaceId: string) {
    return db.execute(sql`
        SELECT id, provider_type, nickname, enabled, managed, selected_model,
               embedding_model, embedding_dimensions
        FROM provider_instances
        WHERE workspace_id = ${workspaceId}::uuid
        ORDER BY preference_order, created_at
    `)
}

/** Routing-chain length per task_type. */
export async function getFlowChains(workspaceId: string) {
    return db.execute(sql`
        SELECT task_type, COUNT(*)::int AS length
        FROM routing_chains
        WHERE workspace_id = ${workspaceId}::uuid
        GROUP BY task_type
        ORDER BY task_type
    `)
}

/** Embedding-provider counts among enabled providers. */
export async function getFlowEmbeddings(workspaceId: string) {
    return db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE embedding_model IS NOT NULL)::int AS embedding_providers,
               COUNT(*)::int AS total_providers
        FROM provider_instances
        WHERE workspace_id = ${workspaceId}::uuid AND enabled = true
    `)
}

/** Workspace intelligence_settings JSON blob. */
export async function getWorkspaceIntelligenceSettings(workspaceId: string) {
    return db.execute(sql`
        SELECT intelligence_settings AS s
        FROM workspaces
        WHERE id = ${workspaceId}::uuid LIMIT 1
    `)
}

/** Inference logs joined to pricing, filtered + capped. */
export async function getInferenceLogs(
    workspaceId: string,
    taskType: string | undefined,
    model: string | undefined,
    fromStr: string | undefined,
    toStr: string | undefined,
    limit: number,
) {
    const taskClause = taskType ? sql`AND il.task_type = ${taskType}` : sql``
    const modelClause = model ? sql`AND il.model = ${model}` : sql``
    const fromClause = fromStr ? sql`AND il.created_at >= ${fromStr}::timestamptz` : sql``
    const toClause = toStr ? sql`AND il.created_at <= ${toStr}::timestamptz` : sql``

    return db.execute(sql`
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
}

/** Top model + top task-type cost breakdown since monthStart. */
export async function getCostBreakdown(workspaceId: string, monthStart: string) {
    return db.execute(sql`
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
}

/** Latest router-v2 stats snapshot per (provider, model, task_type), 2h window. */
export async function getRouterStats() {
    return db.execute(sql`
        SELECT DISTINCT ON (provider, model, task_type)
            provider, model, task_type, sample_count, success_rate,
            latency_p50_ms, latency_p95_ms, cooldown_end_at, snapshot_at
        FROM router_v2_stats
        WHERE snapshot_at > NOW() - INTERVAL '2 hours'
        ORDER BY provider, model, task_type, snapshot_at DESC
    `)
}

/**
 * Warm-start hydration source (AI7): latest snapshot per
 * (workspace_id, provider, model, task_type) within 24h. Unlike getRouterStats
 * (dashboard, 2h, workspace-collapsed) this KEEPS workspace_id because the
 * selector is workspace-scoped, and carries recent_failure_penalty. Caller wraps
 * the result with pgRows().
 */
export async function getRouterStatsForWarmStart() {
    return db.execute(sql`
        SELECT DISTINCT ON (workspace_id, provider, model, task_type)
            workspace_id, provider, model, task_type,
            success_rate, latency_p50_ms, latency_p95_ms,
            recent_failure_penalty, cooldown_end_at
        FROM router_v2_stats
        WHERE snapshot_at > NOW() - INTERVAL '24 hours'
        ORDER BY workspace_id, provider, model, task_type, snapshot_at DESC
    `)
}

/** Count of inference logs in the last 60s for the SSE tick. */
export async function getRecentLogCount(workspaceId: string) {
    return db.execute(sql`
        SELECT COUNT(*)::int AS n
        FROM inference_logs
        WHERE workspace_id = ${workspaceId}::uuid
          AND created_at >= NOW() - INTERVAL '60 seconds'
    `)
}

/** Provider inventory for the first-run detect wizard. */
export async function getDetectProviders(workspaceId: string) {
    return db.execute(sql`
        SELECT id, provider_type, nickname, enabled, managed,
               embedding_model, selected_model
        FROM provider_instances
        WHERE workspace_id = ${workspaceId}::uuid
        ORDER BY preference_order, created_at
    `)
}

/** Flip intelligence_settings.firstRunPending to false (idempotent). */
export async function markWizardComplete(workspaceId: string): Promise<void> {
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
}
