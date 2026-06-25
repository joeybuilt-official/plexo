// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Prometheus-metrics data-access repository (read-only).
 *
 * owns the DB-derived gauge queries. The route keeps the
 * bearer/super-admin auth boundary, per-query non-fatal try/catch, and the
 * setGauge numeric conversion.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

/** Task counts grouped by status. */
export async function getTaskCountsByStatus(): Promise<Array<{ status: string; n: string }>> {
    return db.execute<{ status: string; n: string }>(sql`
        SELECT status::text AS status, COUNT(*)::text AS n
        FROM tasks
        GROUP BY status
    `)
}

/** Total workspace count. */
export async function getWorkspaceCount(): Promise<Array<{ n: string }>> {
    return db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM workspaces`)
}

/** Total memory-entry count. */
export async function getMemoryEntriesCount(): Promise<Array<{ n: string }>> {
    return db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM memory_entries`)
}

/** Distinct active users within a rolling interval (e.g. '7 days'). */
export async function getActiveUsers(interval: string): Promise<Array<{ n: string }>> {
    return db.execute<{ n: string }>(sql`
        SELECT COUNT(DISTINCT user_id)::text AS n
        FROM audit_log
        WHERE created_at >= NOW() - (${interval})::interval
          AND user_id IS NOT NULL
    `)
}

/** Rolling-24h LLM request/token aggregates grouped by provider+model. */
export async function getLlm24h(): Promise<Array<{ provider: string; model: string; tokens_in: string; tokens_out: string; n: string }>> {
    return db.execute<{ provider: string; model: string; tokens_in: string; tokens_out: string; n: string }>(sql`
        SELECT
            COALESCE(provider, 'unknown') AS provider,
            model,
            COALESCE(SUM(input_tokens), 0)::text  AS tokens_in,
            COALESCE(SUM(output_tokens), 0)::text AS tokens_out,
            COUNT(*)::text AS n
        FROM inference_logs
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY provider, model
        LIMIT 500
    `)
}

/** Cumulative API cost since the start of the current ISO week. */
export async function getWeekCostTotal(): Promise<Array<{ total: string }>> {
    return db.execute<{ total: string }>(sql`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM api_cost_tracking
        WHERE week_start = (DATE_TRUNC('week', NOW())::date)
    `)
}
