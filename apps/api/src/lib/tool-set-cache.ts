// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * In-memory TTL cache for per-workspace ToolSets.
 *
 * Rationale
 * ─────────
 * `loadPluginTools(workspaceId)` + `loadSkillContexts(workspaceId)` and
 * `loadConnectionTools(workspaceId)` are called on every chat turn that
 * reaches the executor. Each one can (re)activate PEX workers, read the DB,
 * and do per-extension hydration — order-of-seconds on a warm pool, and
 * tens-of-seconds on a cold pool. A trivial "You working?" message was
 * taking 42s on prod.
 *
 * We cache the loaded ToolSet (or whatever the loader returns) per
 * workspace for a short TTL. Extension install/uninstall + connection
 * install/disconnect routes call `invalidateToolSet()` so the cache
 * busts immediately on mutation.
 *
 * IMPORTANT: this wrapper lives in apps/api/src/lib/ and NOT in
 * packages/agent/src/plugins/ — that directory is owned by the
 * escalation agent and is being edited concurrently.
 */

type Cached<T> = { value: T; expiresAt: number }

export const TOOL_SET_TTL_MS = 60_000

const cache = new Map<string, Cached<unknown>>()

/**
 * Get-or-load a ToolSet-like value by key, caching the result for
 * `TOOL_SET_TTL_MS` milliseconds.
 *
 * The loader is invoked once per cache miss. Concurrent calls with the
 * same key while a load is in flight will each trigger their own load;
 * the race is safe because the loader is idempotent and the last writer
 * wins. If you need single-flight semantics for a heavy loader, extend
 * this to store a Promise in the cache instead of the resolved value.
 */
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

/** Bust the cache for a single key (used by install/uninstall routes). */
export function invalidateToolSet(key: string): void {
    cache.delete(key)
}

/** Bust the cache for every key in a given workspace. */
export function invalidateWorkspaceToolSets(workspaceId: string): void {
    for (const key of cache.keys()) {
        if (key.endsWith(`:${workspaceId}`)) {
            cache.delete(key)
        }
    }
}

/** Nuke the whole cache (tests, admin reset). */
export function invalidateAllToolSets(): void {
    cache.clear()
}

/** Cache stats for tests / diagnostics. */
export function getToolSetCacheStats(): { size: number; keys: string[] } {
    return { size: cache.size, keys: Array.from(cache.keys()) }
}
