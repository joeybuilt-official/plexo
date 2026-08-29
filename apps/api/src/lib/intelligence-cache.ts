// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * In-memory TTL cache for per-workspace intelligence settings.
 *
 * Phase 0 of the intelligence overhaul. Workspace intelligence settings
 * (inference mode, cost ceiling, SCL tunables, etc.) live in
 * `workspaces.intelligence_settings` JSONB and are read on the executor
 * hot path. To avoid per-call DB hits, we cache the resolved settings
 * per workspace for `INTELLIGENCE_TTL_MS`.
 *
 * Phases 1-6 (settings UI surfaces) call `invalidateIntelligenceSettings`
 * after every PATCH so users see their changes immediately.
 *
 * Sister cache: `tool-set-cache.ts` (same pattern, different keyspace).
 */

export type IntelligenceSettings = {
    inferenceMode?: 'auto' | 'byok' | 'proxy' | 'override' | 'auto-economy'
    costCeilingUsd?: number
    costCeilingMode?: 'soft_warn' | 'hard_block' | 'off'
    scl?: {
        enabled: boolean
        driftThreshold?: number
        expandDepth?: number
        expandWidth?: number
        domainRegion?: string
        piiScrubEnabled?: boolean
    }
    reembed?: {
        inProgressJobId?: string
        lastRunAt?: string
    }
    firstRunPending?: boolean
    stepBudget?: 'conservative' | 'normal' | 'thorough'
}

type Cached = { value: IntelligenceSettings; expiresAt: number }

export const INTELLIGENCE_TTL_MS = 60_000

const cache = new Map<string, Cached>()

/**
 * Get-or-load workspace intelligence settings, caching for
 * `INTELLIGENCE_TTL_MS`. The loader is invoked once per cache miss.
 * Concurrent loads for the same workspace are safe — last writer wins
 * because the loader is idempotent (it just reads a JSONB column).
 */
export async function getCachedIntelligenceSettings(
    workspaceId: string,
    loader: () => Promise<IntelligenceSettings>,
): Promise<IntelligenceSettings> {
    const hit = cache.get(workspaceId)
    if (hit && hit.expiresAt > Date.now()) {
        return hit.value
    }
    const value = await loader()
    cache.set(workspaceId, { value, expiresAt: Date.now() + INTELLIGENCE_TTL_MS })
    return value
}

/** Bust the cache for one workspace (called by every settings PATCH route). */
export function invalidateIntelligenceSettings(workspaceId: string): void {
    cache.delete(workspaceId)
}

/** Nuke the entire cache. Tests + admin reset. */
export function invalidateAllIntelligenceSettings(): void {
    cache.clear()
}

/** Diagnostic stats for tests + future health endpoints. */
export function getIntelligenceCacheStats(): { size: number; keys: string[] } {
    return { size: cache.size, keys: Array.from(cache.keys()) }
}
