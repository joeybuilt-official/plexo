// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Routing chain resolver — Phase 2b of the intelligence overhaul.
 *
 * Loads `routing_chains` rows for a (workspace, taskType) pair and
 * returns them in `position` order. The IntelligentRouter walks the
 * chain in `handleByok` / `handleAuto` and falls through to the next
 * entry on a model build failure, mirroring the existing
 * `fallbackChain` semantics — but on a per-task-type basis instead of
 * one workspace-wide chain.
 *
 * Lives in `@plexo/agent` (not `apps/api`) so the executor can import
 * it without inverting the package dep direction. Same pattern as the
 * cost-gate sister module in this package.
 *
 * Process-local 60s cache mirrors the intelligence-cache TTL. Every
 * PATCH /chains route in `apps/api/src/routes/intelligence.ts` calls
 * `invalidateChainResolver(workspaceId)` after the DB write so users
 * see their changes within one resolver lookup.
 */

import { db, sql } from '@plexo/db'

function dbRows<T>(result: unknown): T[] {
    if (result !== null && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows: unknown }).rows)) {
        return (result as { rows: T[] }).rows
    }
    return Array.isArray(result) ? (result as T[]) : []
}

export type ChainTaskType =
    | 'planning'
    | 'codeGeneration'
    | 'verification'
    | 'summarization'
    | 'conversation'
    | 'classification'
    | 'logAnalysis'

export interface ChainEntry {
    /** routing_chains row id, surfaced for debugging. */
    id: string
    providerId: string
    /** Provider type string ('anthropic', 'deepseek', etc) — joined from provider_instances. */
    providerType: string
    modelId: string
    position: number
}

export type WorkspaceChains = Partial<Record<ChainTaskType, ChainEntry[]>>

interface CacheEntry { value: WorkspaceChains; expiresAt: number }

export const CHAIN_RESOLVER_TTL_MS = 60_000

const cache = new Map<string, CacheEntry>()

/** Bust the cache for one workspace. Called by every chain PATCH route. */
export function invalidateChainResolver(workspaceId: string): void {
    cache.delete(workspaceId)
}

/** Tests + admin reset. */
export function invalidateAllChainResolver(): void {
    cache.clear()
}

/** Diagnostic — used by tests. */
export function getChainResolverCacheStats(): { size: number; keys: string[] } {
    return { size: cache.size, keys: Array.from(cache.keys()) }
}

interface ChainRow {
    id: string
    task_type: string
    provider_id: string
    provider_type: string | null
    model_id: string
    position: number
}

async function loadChains(workspaceId: string): Promise<WorkspaceChains> {
    const out: WorkspaceChains = {}
    try {
        const result = await db.execute(sql`
            SELECT
                rc.id,
                rc.task_type,
                rc.provider_id,
                rc.model_id,
                rc.position,
                pi.provider_type
            FROM routing_chains rc
            LEFT JOIN provider_instances pi ON pi.id = rc.provider_id
            WHERE rc.workspace_id = ${workspaceId}::uuid
            ORDER BY rc.task_type, rc.position
        `)
        const rows: ChainRow[] = dbRows<ChainRow>(result)
        for (const row of rows) {
            const tier = row.task_type as ChainTaskType
            if (!out[tier]) out[tier] = []
            out[tier]!.push({
                id: String(row.id),
                providerId: String(row.provider_id),
                providerType: String(row.provider_type ?? ''),
                modelId: String(row.model_id),
                position: Number(row.position),
            })
        }
    } catch {
        // soft-fail — caller treats empty as "no chain configured"
    }
    return out
}

/**
 * Resolve the chain for one (workspace, taskType). Returns `null` if
 * the workspace has no chain rows configured for this task type.
 *
 * The router caller treats `null` as a signal to fall back to the
 * pre-Phase-2b behavior (use the workspace's primary provider + the
 * legacy fallbackChain).
 */
export async function resolveChain(
    workspaceId: string,
    taskType: ChainTaskType,
): Promise<ChainEntry[] | null> {
    const hit = cache.get(workspaceId)
    let value: WorkspaceChains
    if (hit && hit.expiresAt > Date.now()) {
        value = hit.value
    } else {
        value = await loadChains(workspaceId)
        cache.set(workspaceId, { value, expiresAt: Date.now() + CHAIN_RESOLVER_TTL_MS })
    }
    const chain = value[taskType]
    if (!chain || chain.length === 0) return null
    return chain
}
