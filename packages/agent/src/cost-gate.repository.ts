// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the executor-side cost gate (ADR-0045 Phase 2).
 *
 * The ONLY cost-gate module permitted to import the ORM. `sql` comes from
 * `drizzle-orm` directly (not the `@plexo/db` barrel). SQL is unchanged from
 * the previous in-line queries in `cost-gate.ts`.
 */

import { db } from '@plexo/db'
import { sql } from 'drizzle-orm'
import type {
    CostGateRepository,
    AgentIntelligenceSettings,
    TokenCounts,
    FullSpend,
} from './cost-gate.ports.js'

/** Normalize a drizzle `db.execute` result to its first row, across driver shapes. */
function dbRow<T>(result: unknown): T | undefined {
    if (result !== null && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows: unknown }).rows)) {
        return ((result as { rows: T[] }).rows)[0]
    }
    return Array.isArray(result) ? (result as T[])[0] : undefined
}

export class DrizzleCostGateRepository implements CostGateRepository {
    async getIntelligenceSettings(workspaceId: string): Promise<AgentIntelligenceSettings> {
        const result = await db.execute(sql`
            SELECT intelligence_settings AS s
            FROM workspaces
            WHERE id = ${workspaceId}::uuid
            LIMIT 1
        `)
        const row = dbRow<{ s?: AgentIntelligenceSettings }>(result)
        return (row?.s ?? {}) as AgentIntelligenceSettings
    }

    async getTokenCounts(workspaceId: string, monthStartIso: string): Promise<TokenCounts> {
        const result = await db.execute(sql`
            SELECT
                COUNT(*)::int AS requests,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0)::bigint AS input_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0)::bigint AS output_tokens
            FROM inference_logs
            WHERE workspace_id = ${workspaceId}::uuid
              AND created_at >= ${monthStartIso}::timestamptz
              AND success = true
        `)
        const row = dbRow<{ input_tokens?: unknown; output_tokens?: unknown; requests?: unknown }>(result)
        return {
            inputTokens: Number(row?.input_tokens ?? 0),
            outputTokens: Number(row?.output_tokens ?? 0),
            requests: Number(row?.requests ?? 0),
        }
    }

    async getFullSpend(workspaceId: string, monthStartIso: string): Promise<FullSpend> {
        const result = await db.execute(sql`
            WITH this_month AS (
                SELECT COALESCE(il.input_tokens, 0)  AS input_tokens,
                       COALESCE(il.output_tokens, 0) AS output_tokens,
                       il.model,
                       il.provider
                FROM inference_logs il
                WHERE il.workspace_id = ${workspaceId}::uuid
                  AND il.created_at >= ${monthStartIso}::timestamptz
                  AND il.success = true
            ),
            priced AS (
                -- LATERAL picks exactly ONE pricing row per inference log, avoiding
                -- cross-product fan-out when provider is NULL and multiple providers
                -- share the same model_id in models_knowledge.
                SELECT tm.input_tokens, tm.output_tokens,
                       mk.cost_per_m_in, mk.cost_per_m_out
                FROM this_month tm
                LEFT JOIN LATERAL (
                    SELECT cost_per_m_in, cost_per_m_out
                    FROM models_knowledge
                    WHERE model_id = tm.model
                      AND (tm.provider IS NULL OR provider = tm.provider)
                    ORDER BY (provider = tm.provider) DESC NULLS LAST
                    LIMIT 1
                ) mk ON TRUE
            )
            SELECT
                COUNT(*)::int AS requests,
                COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(
                    CASE WHEN cost_per_m_in IS NOT NULL
                         THEN (input_tokens::numeric / 1000000.0) * cost_per_m_in ELSE 0 END
                  + CASE WHEN cost_per_m_out IS NOT NULL
                         THEN (output_tokens::numeric / 1000000.0) * cost_per_m_out ELSE 0 END
                ), 0)::float8 AS priced_usd
            FROM priced
        `)
        const row = dbRow<{ priced_usd?: unknown; input_tokens?: unknown; output_tokens?: unknown; requests?: unknown }>(result) ?? {}
        return {
            pricedUsd: Number(row.priced_usd ?? 0),
            inputTokens: Number(row.input_tokens ?? 0),
            outputTokens: Number(row.output_tokens ?? 0),
            requests: Number(row.requests ?? 0),
        }
    }
}
