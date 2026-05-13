// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace spend aggregator — Phase 2a of the intelligence overhaul.
 *
 * Computes the current calendar-month USD spend for a workspace by joining
 * `inference_logs` to `models_knowledge` and pricing each row at
 *   (input_tokens / 1e6) * cost_per_m_in + (output_tokens / 1e6) * cost_per_m_out.
 *
 * Rows whose model is missing from the knowledge table contribute $0
 * (we don't have a price), but their token counts are still surfaced so
 * the UI can show "billed bytes vs unpriced bytes".
 *
 * Cached per workspace with a short TTL because spend changes constantly
 * but a stale value within the TTL is fine for UI display + the
 * cost-enforcement middleware (which is allowed to be slightly behind).
 *
 * The 80%/100% cost-enforcement check in `cost-enforcement.ts` reads
 * through this helper, so the cache also bounds DB load on the executor
 * hot path.
 */

import { db, sql } from '@plexo/db'
import { pgRows } from './pg-rows.js'

export interface WorkspaceSpend {
    workspaceId: string
    /** Month start in ISO (UTC) for the bucket this snapshot covers. */
    monthStart: string
    /** USD spent across priced models this month. */
    pricedUsd: number
    /** Token totals this month, regardless of whether they were priced. */
    inputTokens: number
    outputTokens: number
    /** Number of inference_logs rows aggregated. */
    requests: number
    /** Tokens whose model was not in models_knowledge (cost contribution = 0). */
    unpricedInputTokens: number
    unpricedOutputTokens: number
    /** When this snapshot was computed. */
    computedAt: string
}

interface Cached { value: WorkspaceSpend; expiresAt: number }

const cache = new Map<string, Cached>()
export const SPEND_TTL_MS = 5 * 60 * 1000  // 5 minutes — short because spend moves

function monthStartUtc(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

/**
 * Compute (or read from cache) the workspace's current-month spend.
 * Caller should treat the returned snapshot as best-effort — it can be
 * up to SPEND_TTL_MS stale.
 */
export async function getWorkspaceSpend(workspaceId: string): Promise<WorkspaceSpend> {
    const hit = cache.get(workspaceId)
    if (hit && hit.expiresAt > Date.now()) return hit.value

    const value = await loadWorkspaceSpend(workspaceId)
    cache.set(workspaceId, { value, expiresAt: Date.now() + SPEND_TTL_MS })
    return value
}

/** Bypass the cache and read fresh from the DB. */
export async function loadWorkspaceSpend(workspaceId: string): Promise<WorkspaceSpend> {
    const start = monthStartUtc()
    // We do the priced sum + the unpriced bookkeeping in a single round trip
    // via two CTEs joined on the same `inference_logs` slice.
    //
    // models_knowledge.id is `${provider}/${model_id}` — we match on either
    // (provider, model) or just model when the log row didn't capture the
    // provider. This intentionally over-matches in the rare provider==null
    // case rather than under-counting spend.
    const result = await db.execute(sql`
        WITH this_month AS (
            SELECT
                il.provider,
                il.model,
                COALESCE(il.input_tokens, 0) AS input_tokens,
                COALESCE(il.output_tokens, 0) AS output_tokens
            FROM inference_logs il
            WHERE il.workspace_id = ${workspaceId}::uuid
              AND il.created_at >= ${start.toISOString()}::timestamptz
              AND il.success = true
        ),
        priced AS (
            SELECT
                tm.input_tokens,
                tm.output_tokens,
                mk.cost_per_m_in,
                mk.cost_per_m_out
            FROM this_month tm
            LEFT JOIN models_knowledge mk
              ON mk.model_id = tm.model
             AND (tm.provider IS NULL OR mk.provider = tm.provider)
        )
        SELECT
            COUNT(*)::int AS requests,
            COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
            COALESCE(SUM(
                CASE WHEN cost_per_m_in IS NOT NULL
                     THEN (input_tokens::numeric / 1000000.0) * cost_per_m_in
                     ELSE 0
                END
              + CASE WHEN cost_per_m_out IS NOT NULL
                     THEN (output_tokens::numeric / 1000000.0) * cost_per_m_out
                     ELSE 0
                END
            ), 0)::float8 AS priced_usd,
            COALESCE(SUM(
                CASE WHEN cost_per_m_in IS NULL THEN input_tokens ELSE 0 END
            ), 0)::bigint AS unpriced_input_tokens,
            COALESCE(SUM(
                CASE WHEN cost_per_m_out IS NULL THEN output_tokens ELSE 0 END
            ), 0)::bigint AS unpriced_output_tokens
        FROM priced
    `)

    const row = pgRows(result)?.[0]
        ?? (Array.isArray(result) ? (result as any[])[0] : undefined)
        ?? {}

    return {
        workspaceId,
        monthStart: start.toISOString(),
        pricedUsd: Number(row.priced_usd ?? 0),
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        requests: Number(row.requests ?? 0),
        unpricedInputTokens: Number(row.unpriced_input_tokens ?? 0),
        unpricedOutputTokens: Number(row.unpriced_output_tokens ?? 0),
        computedAt: new Date().toISOString(),
    }
}

/** Bust the spend cache for one workspace. */
export function invalidateWorkspaceSpend(workspaceId: string): void {
    cache.delete(workspaceId)
}

/** Tests + admin-reset. */
export function invalidateAllWorkspaceSpend(): void {
    cache.clear()
}

/** Diagnostic — used by tests. */
export function getSpendCacheStats(): { size: number; keys: string[] } {
    return { size: cache.size, keys: Array.from(cache.keys()) }
}
