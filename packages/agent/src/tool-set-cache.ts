// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * In-process TTL cache for per-workspace tool sets.
 *
 * `loadPluginTools` / `loadConnectionTools` / `loadSkillContexts` are the
 * hottest calls in the executor — they (re)hydrate workers + DB state on
 * every invocation. For short-lived chat turns that only differ by a few
 * seconds, re-loading is pure overhead.
 *
 * We cache by a namespaced key (`plugins:<workspaceId>`, `connections:<id>`,
 * `skills:<id>`, ...) for a short TTL. Extension/connection install +
 * uninstall routes should call `invalidateToolSet()` so mutations are
 * reflected immediately.
 *
 * This file is INDEPENDENT of `plugins/bridge.ts` — it is not allowed to
 * be modified by the escalation agent, so callers wrap the bridge's
 * loader functions here without touching them.
 */

type Cached<T> = { value: T; expiresAt: number }

export const TOOL_SET_TTL_MS = 60_000

const cache = new Map<string, Cached<unknown>>()

export async function getCachedToolSet<T>(
    key: string,
    loader: () => Promise<T>,
): Promise<T> {
    const hit = cache.get(key)
    if (hit && hit.expiresAt > Date.now()) {
        return hit.value as T
    }
    const value = await loader()
    cache.set(key, { value, expiresAt: Date.now() + TOOL_SET_TTL_MS })
    return value
}

export function invalidateToolSet(key: string): void {
    cache.delete(key)
}

export function invalidateWorkspaceToolSets(workspaceId: string): void {
    for (const key of cache.keys()) {
        if (key.endsWith(`:${workspaceId}`)) {
            cache.delete(key)
        }
    }
}

export function invalidateAllToolSets(): void {
    cache.clear()
}

export function getToolSetCacheStats(): { size: number; keys: string[] } {
    return { size: cache.size, keys: Array.from(cache.keys()) }
}

/**
 * Return the cached value for `key` only if warm — does NOT invoke the loader.
 * Safe to call from self-knowledge tools and capability manifests without risk
 * of triggering expensive worker activations.
 */
export function peekCachedToolSet<T>(key: string): T | undefined {
    const hit = cache.get(key)
    if (hit && hit.expiresAt > Date.now()) {
        return hit.value as T
    }
    return undefined
}
