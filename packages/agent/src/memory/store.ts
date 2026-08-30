// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Semantic memory — store and retrieve task outcomes with pgvector similarity search.
 *
 * Redis cache layer:
 * - Search results: cached 5 min keyed by workspace+query+type
 * - Preferences: cached 10 min, invalidated on write
 * - All keys under plexo:memory:<workspaceId>:*
 *
 * Embedding strategy:
 * - If OPENAI_API_KEY is set: use text-embedding-3-small (1536-dim)
 * - Otherwise: store content without embedding (text-only fallback via ILIKE search)
 */
import pino from 'pino'
import { generateText } from 'ai'
import { sqlArray } from '../sql-array.js'
import { DrizzleMemoryRetrievalStore, DrizzleMemoryEntryStore } from '../memory.repository.js'
import type { MemoryRetrievalStore, MemoryRecord } from '../memory.ports.js'
import { type WorkspaceAISettings } from '../providers/registry.js'
import { routeAndCall } from '../providers/router-v2/index.js'
import {
    DEFAULT_NAMESPACE,
    SHARED_NAMESPACE,
    defaultNamespaceForAgent,
    sharedNamespaces,
} from './namespace.js'
import { emitMemoryCacheHit, emitMemoryCacheMiss } from '../analytics/memory-events.js'
import { inngest } from '@plexo/queue/inngest'

const logger = pino({ name: 'memory' })

let retrievalStore: MemoryRetrievalStore = new DrizzleMemoryRetrievalStore()
const entryStore = new DrizzleMemoryEntryStore()

/** Test seam — swap in a fake store. */
export function setMemoryRetrievalStore(next: MemoryRetrievalStore): void {
    retrievalStore = next
}

export type MemoryType = 'task' | 'incident' | 'session' | 'pattern'

export type MemoryTier = 'hot' | 'active' | 'cold'

export interface MemoryEntry {
    id: string
    workspaceId: string
    type: MemoryType
    content: string
    shorthand?: string
    metadata: Record<string, unknown>
    tier: MemoryTier
    confidence: number | null
    /** Phase 10 — per-agent memory slice. See namespace.ts. */
    namespace: string
    createdAt: Date
}

export interface MemorySearchResult extends MemoryEntry {
    similarity: number
}

// ── Redis client (lazy singleton) ─────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
let _redis: any = null
async function getRedis(): Promise<any | null> {
    if (_redis) return _redis
    try {
        const { createClient } = await import('redis')
        const client = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
        await client.connect()
        _redis = client
        return _redis
    } catch {
        return null
    }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const SEARCH_TTL = 5 * 60        // 5 min
const PREF_TTL = 10 * 60         // 10 min

function searchKey(workspaceId: string, query: string, type?: string) {
    return `plexo:memory:${workspaceId}:search:${type ?? 'all'}:${query.slice(0, 60).replace(/[^a-z0-9]/gi, '_').toLowerCase()}`
}

function prefKey(workspaceId: string) {
    return `plexo:memory:${workspaceId}:prefs`
}

/** Invalidate all search caches for a workspace on new writes. */
async function invalidateSearchCache(workspaceId: string) {
    try {
        const redis = await getRedis()
        if (!redis) return
        const pattern = `plexo:memory:${workspaceId}:search:*`
        const keys: string[] = []
        for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
            keys.push(key)
        }
        if (keys.length > 0) await redis.del(keys)
    } catch (err) {
        logger.warn({ err, workspaceId }, 'search cache invalidation failed (non-fatal)')
    }
}

// ── Embedding ─────────────────────────────────────────────────────────────────

import { resolveEmbeddingAdapterAsync } from '../embeddings/router.js'

/**
 * Circuit breaker: after 2 consecutive failures, stop retrying for 15 minutes.
 * Tripped immediately on 401/403 (auth) since retries will never recover.
 *
 * FUN-031: Per-provider breaker so workspace A's provider going down
 * doesn't block workspace B using a different provider.
 */
const _embedBreakers = new Map<string, { disabledUntil: number; failures: number }>()

function getBreaker(providerId: string): { disabledUntil: number; failures: number } {
    if (!_embedBreakers.has(providerId)) {
        _embedBreakers.set(providerId, { disabledUntil: 0, failures: 0 })
    }
    return _embedBreakers.get(providerId)!
}

function isTransientNetworkError(errMsg: string, status?: number): boolean {
    if (status && status >= 500 && status < 600) return true
    return /ConnectTimeoutError|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|fetch failed|Timeout|AbortError|connect ECONNREFUSED/i.test(errMsg)
}

/**
 * Generate an embedding vector using the workspace's configured provider.
 * Returns null if no provider is available or if the call fails.
 */
export async function embed(text: string, workspaceId: string, aiSettings?: WorkspaceAISettings): Promise<number[] | null> {
    const resolution = await resolveEmbeddingAdapterAsync(workspaceId, aiSettings)
    if (!resolution.adapter || resolution.status !== 'active') return null

    // FUN-031: per-provider circuit breaker
    const providerId = resolution.providerId ?? 'unknown'
    const breaker = getBreaker(providerId)
    if (Date.now() < breaker.disabledUntil) return null

    try {
        const vec = await resolution.adapter.embed(text)
        breaker.failures = 0 // reset on success
        return vec
    } catch (err: unknown) {
        const status = (err as { status?: number })?.status
        const errMsg = err instanceof Error ? err.message : String(err)

        if (status === 401 || status === 403) {
            breaker.disabledUntil = Date.now() + 15 * 60 * 1000
            breaker.failures = 0
            logger.warn({ status, provider: providerId, error: errMsg }, 'Embedding auth failed — disabling provider for 15 min')
            return null
        }

        if (isTransientNetworkError(errMsg, status)) {
            breaker.failures++
            if (breaker.failures >= 2) {
                breaker.disabledUntil = Date.now() + 15 * 60 * 1000
                breaker.failures = 0
                logger.warn({ provider: providerId, error: errMsg }, 'Embedding provider unreachable after 2 attempts — circuit breaker tripped for 15 min')
            } else {
                logger.warn({ provider: providerId, error: errMsg, consecutiveFailures: breaker.failures }, 'Embedding provider unreachable')
            }
        } else {
            logger.warn({ provider: providerId, error: errMsg }, 'Embedding failed — storing without vector')
        }
        return null
    }
}

// ── Summarization ────────────────────────────────────────────────────────────

const SHORTHAND_SYSTEM_PROMPT = 'Use the provided memory facts directly — do not summarize or compress them.'

async function summarizeMemory(params: {
    content: string,
    workspaceId: string,
    aiSettings?: WorkspaceAISettings
}): Promise<string | null> {
    const { content, workspaceId, aiSettings } = params

    // Fire-and-forget memory writes must not burn 30s of retries when a
    // provider is down. Cap at one attempt, 15 seconds total.
    const abortSignal = AbortSignal.timeout(15_000)

    try {
        if (aiSettings) {
            // Use full provider chain (e.g. DeepSeek → Groq → Ollama)
            const text = await routeAndCall({
                workspaceId,
                taskType: 'summarization',
                settings: aiSettings,
                doCall: (model) => generateText({
                    model,
                    system: SHORTHAND_SYSTEM_PROMPT,
                    messages: [{ role: 'user', content }],
                    maxRetries: 1,
                    abortSignal,
                    // @ts-expect-error maxTokens exists in AI SDK v6 but type inference misses it
                    maxTokens: 150,
                }).then((r) => r.text),
            })
            return text.trim() || null
        }

        // No workspace settings available. Skip LLM summarization entirely
        // so the hot path isn't blocked by env-var resolution and a provider
        // that may be missing or unreachable. The memory row still gets
        // stored + embedded; shorthand is a nice-to-have, not critical.
        return null
    } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Memory summarization failed')
        return null
    }
}

// ── Store ─────────────────────────────────────────────────────────────────────

export async function storeMemory(params: {
    workspaceId: string
    type: MemoryType
    content: string
    metadata?: Record<string, unknown>
    tier?: MemoryTier
    aiSettings?: WorkspaceAISettings
    /**
     * Phase 10 — per-agent memory slice. Defaults to 'default' to keep
     * pre-phase-10 callers unchanged. Pass the result of
     * `defaultNamespaceForAgent` to scope this write to a specific agent.
     * The special 'shared' namespace is NOT accepted here on purpose —
     * use `writeShared` for that.
     */
    namespace?: string
    /** Optional agent id shortcut — if provided and `namespace` is not,
     *  the namespace is computed as `agent-${agentId}`. */
    agentId?: string
}): Promise<string> {
    const { workspaceId, type, content, metadata = {}, tier = 'active', aiSettings } = params
    // Explicit namespace wins; otherwise derive from agentId; otherwise default.
    // Silently coerce an accidental 'shared' write to 'default' — shared writes
    // MUST go through writeShared so the caller can't footgun by typo.
    let namespace = params.namespace ?? defaultNamespaceForAgent(params.agentId)
    if (namespace === SHARED_NAMESPACE) {
        logger.warn({ workspaceId, type }, 'storeMemory received shared namespace — coerced to default; use writeShared() instead')
        namespace = DEFAULT_NAMESPACE
    }

    if (!await retrievalStore.workspaceExists(workspaceId)) {
        logger.warn({ workspaceId, type }, 'storeMemory: workspace not found — skipping write')
        return ''
    }

    const id = crypto.randomUUID()

    await retrievalStore.write({
        id,
        workspaceId,
        type,
        content,
        metadata,
        tier,
        namespace,
    })

    // Invalidate search cache on every write
    void invalidateSearchCache(workspaceId)

    // Generate shorthand synchronously so it exists before any search
    try {
        const shorthand = await summarizeMemory({ content, workspaceId, aiSettings })
        if (shorthand) {
            await retrievalStore.setShorthand(id, shorthand)
        }
    } catch (err) {
        logger.error({ err, id }, 'Failed to update shorthand')
    }

    // Embedding floor: pattern/note rows MUST land with an embedding so
    // semantic search never sees nulls. For other types we use the durable
    // Inngest job (Phase 3.5) so non-knowledge hot-path writes (task outcomes,
    // incidents) stay snappy while gaining retry + DLQ visibility.
    const mustAwaitEmbedding = type === 'pattern' || (type as string) === 'note'
    if (mustAwaitEmbedding) {
        try {
            const vector = await embed(content, workspaceId, aiSettings)
            if (vector) {
                await entryStore.setEmbedding(id, vector)
            } else {
                logger.warn({ id, workspaceId, type }, 'embed() returned null for pattern/note — enqueueing for retry')
                void inngest.send({
                    name: 'memory.embedding.requested',
                    data: { workspaceId, memoryEntryId: id, content, aiSettings },
                }).catch((err) => logger.error({ err, id }, 'Failed to enqueue embedding job'))
            }
        } catch (err) {
            logger.error({ err, id }, 'Failed to embed pattern/note synchronously — enqueueing for retry')
            void inngest.send({
                name: 'memory.embedding.requested',
                data: { workspaceId, memoryEntryId: id, content, aiSettings },
            }).catch((err) => logger.error({ err, id }, 'Failed to enqueue embedding job'))
        }
    } else {
        // Fire-and-forget replaced with durable Inngest job (Phase 3.5).
        // The embedding is generated asynchronously with retry + DLQ.
        void inngest.send({
            name: 'memory.embedding.requested',
            data: { workspaceId, memoryEntryId: id, content, aiSettings },
        }).catch((err) => logger.error({ err, id }, 'Failed to enqueue embedding job'))
    }

    return id
}

// ── Retrieve: semantic search ─────────────────────────────────────────────────

/** Promote a memory entry to hot tier (async, non-blocking). */
function promoteTier(ids: string[]): void {
    if (ids.length === 0) return
    void retrievalStore.promoteToHot(ids)
        .catch((err) => logger.warn({ err, count: ids.length }, 'Tier promotion failed'))
}

/** Map a stored record onto the public search result shape. */
function toResult(r: MemoryRecord, similarity: number): MemorySearchResult {
    return {
        id: r.id,
        workspaceId: r.workspaceId,
        type: r.type as MemoryType,
        content: r.content,
        shorthand: r.shorthand ?? undefined,
        metadata: r.metadata,
        tier: r.tier as MemoryTier,
        confidence: r.confidence,
        namespace: r.namespace,
        createdAt: r.createdAt,
        similarity,
    }
}

export async function searchMemory(params: {
    workspaceId: string
    query?: string
    type?: MemoryType
    limit?: number
    useCache?: boolean
    /**
     * Phase 10 — read from a specific namespace. Defaults to 'default'
     * so pre-phase-10 callers keep seeing exactly the rows they saw
     * before. Mutually exclusive with `namespaces` — if both are set,
     * `namespaces` wins.
     */
    namespace?: string
    /**
     * Phase 10 — read across multiple namespaces in one call. Useful for
     * `sharedNamespaces(agentId)` which returns `['agent-foo','shared']`
     * so an agent sees both its own slice and the cross-agent shared
     * slice in a single query.
     */
    namespaces?: string[]
    /** Optional agent id shortcut — if provided and neither `namespace`
     *  nor `namespaces` is set, the search spans
     *  `[agent-${agentId}, 'shared']`. */
    agentId?: string
}): Promise<MemorySearchResult[]> {
    const { workspaceId, query, type, limit = 5, useCache = true } = params

    // Namespace resolution precedence: namespaces[] → namespace → agentId → default.
    const resolvedNamespaces: string[] = (() => {
        if (params.namespaces && params.namespaces.length > 0) return params.namespaces
        if (params.namespace) return [params.namespace]
        if (params.agentId) return sharedNamespaces(params.agentId)
        return [DEFAULT_NAMESPACE]
    })()
    const nsCacheKey = resolvedNamespaces.slice().sort().join(',')

    if (useCache) {
        try {
            const redis = await getRedis()
            if (redis) {
                const cached = await redis.get(searchKey(workspaceId, (query || '') + '|ns:' + nsCacheKey, type))
                if (cached) {
                    emitMemoryCacheHit({ workspaceId, cacheKind: 'search' })
                    return JSON.parse(cached) as MemorySearchResult[]
                }
                emitMemoryCacheMiss({ workspaceId, cacheKind: 'search' })
            }
        } catch { /* non-fatal */ }
    }

    const vector = query?.trim() ? await embed(query, workspaceId) : null
    let results: MemorySearchResult[]

    if (vector) {
        results = (await retrievalStore.searchByVector({
            workspaceId, namespaces: resolvedNamespaces, type, limit, embedding: vector,
        })).map((r) => toResult(r, r.similarity))
    } else {
        // No embedding available, or the query was empty: newest-first with an
        // optional substring match. The 0.5 is not a score — it is this layer
        // saying "unknown without a vector", which is why it is applied here
        // and not inside the adapter.
        results = (await retrievalStore.searchByText({
            workspaceId, namespaces: resolvedNamespaces, type, limit, text: query,
        })).map((r) => toResult(r, 0.5))
    }
    // Promote retrieved entries to hot tier (non-blocking)
    promoteTier(results.map((r) => r.id))

    if (useCache && results.length > 0) {
        try {
            const redis = await getRedis()
            if (redis) {
                await redis.setEx(searchKey(workspaceId, (query || '') + '|ns:' + nsCacheKey, type), SEARCH_TTL, JSON.stringify(results))
            }
        } catch { /* non-fatal */ }
    }

    return results
}

export async function searchMemoryBatch(params: {
    workspaceId: string
    queries: string[]
    type?: MemoryType
    limit?: number
    useCache?: boolean
    namespace?: string
    namespaces?: string[]
    agentId?: string
}): Promise<Map<string, MemorySearchResult[]>> {
    const { workspaceId, queries, type, limit = 5, useCache = true } = params

    if (queries.length === 0) return new Map()

    const resolvedNamespaces: string[] = (() => {
        if (params.namespaces && params.namespaces.length > 0) return params.namespaces
        if (params.namespace) return [params.namespace]
        if (params.agentId) return sharedNamespaces(params.agentId)
        return [DEFAULT_NAMESPACE]
    })()
    const nsCacheKey = resolvedNamespaces.slice().sort().join(',')

    const resultMap = new Map<string, MemorySearchResult[]>()

    if (useCache) {
        try {
            const redis = await getRedis()
            if (redis) {
                const cacheKeys = queries.map(q => searchKey(workspaceId, (q || '') + '|ns:' + nsCacheKey, type))
                const cachedResults = await redis.mGet(cacheKeys)
                let allCached = true
                for (let i = 0; i < queries.length; i++) {
                    if (cachedResults[i]) {
                        resultMap.set(queries[i]!, JSON.parse(cachedResults[i]!) as MemorySearchResult[])
                    } else {
                        allCached = false
                    }
                }
                if (allCached) {
                    emitMemoryCacheHit({ workspaceId, cacheKind: 'search' })
                    return resultMap
                }
                if (resultMap.size > 0) {
                    emitMemoryCacheHit({ workspaceId, cacheKind: 'search' })
                }
                if (resultMap.size < queries.length) {
                    emitMemoryCacheMiss({ workspaceId, cacheKind: 'search' })
                }
            }
        } catch { /* non-fatal */ }
    }

    const uncachedQueries = queries.filter(q => !resultMap.has(q))
    if (uncachedQueries.length === 0) return resultMap

    const vectors = await Promise.all(
        uncachedQueries.map(q => q.trim() ? embed(q, workspaceId) : Promise.resolve(null))
    )

    for (let i = 0; i < uncachedQueries.length; i++) {
        const query = uncachedQueries[i]!
        const vector = vectors[i]!

        // The same two port calls searchMemory makes. Before this extraction
        // the loop carried its own byte-identical copy of both queries, so any
        // change to the ranking had to be made twice or silently diverge.
        const results: MemorySearchResult[] = vector
            ? (await retrievalStore.searchByVector({
                workspaceId, namespaces: resolvedNamespaces, type, limit, embedding: vector,
            })).map((r) => toResult(r, r.similarity))
            : (await retrievalStore.searchByText({
                workspaceId, namespaces: resolvedNamespaces, type, limit, text: query,
            })).map((r) => toResult(r, 0.5))
        // Promote retrieved entries to hot tier (non-blocking)
        promoteTier(results.map((r) => r.id))

        resultMap.set(query, results)

        if (useCache && results.length > 0) {
            try {
                const redis = await getRedis()
                if (redis) {
                    await redis.setEx(searchKey(workspaceId, (query || '') + '|ns:' + nsCacheKey, type), SEARCH_TTL, JSON.stringify(results))
                }
            } catch { /* non-fatal */ }
        }
    }

    return resultMap
}

// ── Record task outcome as memory (DISABLED — ADR 0017) ─────────────────────
// Per ADR 0017: agent task logs constitute 85% of memory_entries with zero
// retrieval_count. Disabled at the recording layer; callers compile + behave
// as no-ops. Re-enable by reverting this commit if the task-as-memory pattern
// is needed again (no schema or interface changes).

export async function recordTaskMemory(params: {
    workspaceId: string
    taskId: string
    description: string
    outcome: 'success' | 'failure' | 'partial'
    toolsUsed: string[]
    qualityScore?: number
    durationMs?: number
    notes?: string
    aiSettings?: WorkspaceAISettings
    namespace?: string
    agentId?: string
}): Promise<void> {
    const { workspaceId, taskId, outcome, agentId, namespace } = params
    logger.debug(
        { taskId, outcome, workspaceId, namespace: namespace ?? defaultNamespaceForAgent(agentId) },
        'recordTaskMemory called but DISABLED (ADR 0017) — no write performed',
    )
}

// ── Direct user-instruction memory write ─────────────────────────────────────

export async function rememberInstruction(params: {
    workspaceId: string
    instruction: string
    source?: 'chat' | 'api' | 'telegram'
    aiSettings?: WorkspaceAISettings
    /** Phase 10 — optional per-agent namespace. */
    namespace?: string
    agentId?: string
}): Promise<string> {
    const { workspaceId, instruction, source = 'chat', aiSettings, namespace, agentId } = params

    const id = await storeMemory({
        workspaceId,
        type: 'pattern',
        content: instruction,
        metadata: {
            source,
            userInstruction: true,
            recordedAt: new Date().toISOString(),
        },
        aiSettings,
        namespace,
        agentId,
    })

    // Also invalidate prefs cache since this may affect behavior
    try {
        const redis = await getRedis()
        if (redis) await redis.del(prefKey(workspaceId))
    } catch { /* non-fatal */ }

    logger.info({ workspaceId, source }, 'User instruction stored to memory')
    return id
}

// ── Shared-namespace write (Phase 10) ────────────────────────────────────────

/**
 * Write a memory entry into the cross-agent 'shared' namespace.
 *
 * Any agent in the workspace can read these rows via `sharedNamespaces`,
 * but only this explicit helper may create them. Use it for knowledge
 * that should benefit every agent (e.g. a verified workspace fact, a
 * corrected user preference).
 */
export async function writeShared(params: {
    workspaceId: string
    type: MemoryType
    content: string
    metadata?: Record<string, unknown>
    tier?: MemoryTier
    aiSettings?: WorkspaceAISettings
    /** The agent id responsible for this shared write, recorded in
     *  metadata for auditability. Optional. */
    authorAgentId?: string
}): Promise<string> {
    const { authorAgentId, metadata = {}, ...rest } = params

    const id = crypto.randomUUID()
    const mergedMetadata = {
        ...metadata,
        sharedBy: authorAgentId ?? null,
        sharedAt: new Date().toISOString(),
    }

    await retrievalStore.write({
        id,
        workspaceId: rest.workspaceId,
        type: rest.type,
        content: rest.content,
        metadata: mergedMetadata,
        tier: rest.tier ?? 'active',
        namespace: SHARED_NAMESPACE,
    })

    void invalidateSearchCache(rest.workspaceId)

    // Shorthand + embedding generation happens async, mirrors storeMemory.
    try {
        const shorthand = await summarizeMemory({
            content: rest.content,
            workspaceId: rest.workspaceId,
            aiSettings: rest.aiSettings,
        })
        if (shorthand) {
            await retrievalStore.setShorthand(id, shorthand)
        }
    } catch (err) {
        logger.error({ err, id }, 'Failed to update shorthand (shared write)')
    }

    // Embedding floor (Phase 1): same rule as storeMemory — pattern/note
    // shared writes await the embedding so the row never lands null.
    const mustAwaitEmbedding = rest.type === 'pattern' || (rest.type as string) === 'note'
    if (mustAwaitEmbedding) {
        try {
            const vector = await embed(rest.content, rest.workspaceId, rest.aiSettings)
            if (vector) {
                await entryStore.setEmbedding(id, vector)
            }
        } catch (err) {
            logger.error({ err, id }, 'Failed to embed shared pattern/note synchronously')
        }
    } else {
        embed(rest.content, rest.workspaceId, rest.aiSettings).then(async (vector) => {
            if (!vector) return
            await entryStore.setEmbedding(id, vector)
        }).catch((err) => logger.error({ err, id }, 'Failed to update embedding (shared write)'))
    }

    return id
}

// ── Preferences cache helpers (used by preferences.ts) ───────────────────────

export async function getCachedPreferences(workspaceId: string): Promise<Record<string, unknown> | null> {
    try {
        const redis = await getRedis()
        if (!redis) return null
        const cached = await redis.get(prefKey(workspaceId))
        if (cached) return JSON.parse(cached) as Record<string, unknown>
    } catch { /* non-fatal */ }
    return null
}

export async function setCachedPreferences(workspaceId: string, prefs: Record<string, unknown>): Promise<void> {
    try {
        const redis = await getRedis()
        if (!redis) return
        await redis.setEx(prefKey(workspaceId), PREF_TTL, JSON.stringify(prefs))
    } catch { /* non-fatal */ }
}

export async function invalidatePrefsCache(workspaceId: string): Promise<void> {
    try {
        const redis = await getRedis()
        if (!redis) return
        await redis.del(prefKey(workspaceId))
    } catch { /* non-fatal */ }
}
