// SPDX-License-Identifier: AGPL-3.0-only
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
import { db, eq, ne, and, desc, sql, inArray } from '@plexo/db'
import { memoryEntries, workspaces } from '@plexo/db'
import { type WorkspaceAISettings } from '../providers/registry.js'
import { routeAndCall } from '../providers/router-v2/index.js'
import {
    DEFAULT_NAMESPACE,
    SHARED_NAMESPACE,
    defaultNamespaceForAgent,
    sharedNamespaces,
} from './namespace.js'
import { emitMemoryCacheHit, emitMemoryCacheMiss } from '../analytics/memory-events.js'

const logger = pino({ name: 'memory' })

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

    const wsRows = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (wsRows.length === 0) {
        logger.warn({ workspaceId, type }, 'storeMemory: workspace not found — skipping write')
        return ''
    }

    const id = crypto.randomUUID()

    const { getWriteBackend, shouldWritePostgres, shouldMirrorGraphiti, mirrorToGraphiti } = await import('./write-backend.js')
    const backend = getWriteBackend()

    if (shouldMirrorGraphiti(backend)) {
        void mirrorToGraphiti({
            workspaceId,
            content,
            sourceDescription: `app:plexo|src:storeMemory|ns:${namespace}`,
            name: `${type}-${id.slice(0, 8)}`,
            metadata: { type, tier, namespace, ...(metadata as Record<string, unknown>) },
        })
    }

    if (!shouldWritePostgres(backend)) {
        // Graphiti-only mode — skip the entire postgres write + shorthand + embed
        // chain. Callers receive the generated id so the analytics surface
        // stays consistent; Phase 6 (read-path cutover) replaces any postgres-
        // dependent reads of this id.
        void invalidateSearchCache(workspaceId)
        return id
    }

    await db.insert(memoryEntries).values({
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
            await db.update(memoryEntries)
                .set({ shorthand })
                .where(eq(memoryEntries.id, id))
        }
    } catch (err) {
        logger.error({ err, id }, 'Failed to update shorthand')
    }

    // Embedding floor (Phase 1): pattern/note rows MUST land with an
    // embedding so clusterMemory + suggest never see nulls. For other
    // types we keep the legacy fire-and-forget path so non-knowledge
    // hot-path writes (task outcomes, incidents) stay snappy.
    const mustAwaitEmbedding = type === 'pattern' || (type as string) === 'note'
    if (mustAwaitEmbedding) {
        try {
            const vector = await embed(content, workspaceId, aiSettings)
            if (vector) {
                const vecStr = `[${vector.join(',')}]`
                await db.execute(
                    sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`,
                )
            } else {
                logger.warn({ id, workspaceId, type }, 'embed() returned null for pattern/note — row will land without embedding')
            }
        } catch (err) {
            logger.error({ err, id }, 'Failed to embed pattern/note synchronously')
        }
    } else {
        embed(content, workspaceId, aiSettings).then(async (vector) => {
            if (!vector) return
            const vecStr = `[${vector.join(',')}]`
            await db.execute(
                sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`,
            )
        }).catch((err) => logger.error({ err, id }, 'Failed to update embedding'))
    }

    return id
}

// ── Retrieve: semantic search ─────────────────────────────────────────────────

/** Promote a memory entry to hot tier (async, non-blocking). */
function promoteTier(ids: string[]): void {
    if (ids.length === 0) return
    db.execute(
        sql`UPDATE memory_entries SET tier = 'hot' WHERE id = ANY(${ids}::uuid[]) AND tier != 'hot'`,
    ).catch(() => { /* non-fatal */ })
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

    // Phase 6 — read-backend gateway. In graphiti mode, delegate to the
    // sidecar's hybrid search and short-circuit. Postgres mode (default)
    // keeps today's path. Bridge-not-configured falls through to postgres
    // so dev workflows w/o the sidecar don't break.
    if (query && query.trim().length > 0) {
        const { getReadBackend, readFromGraphiti } = await import('./read-backend.js')
        if (getReadBackend() === 'graphiti') {
            const grResults = await readFromGraphiti({ workspaceId, queryText: query, limit })
            if (grResults !== null) {
                // Apply type filter client-side (Graphiti collapses Plexo's
                // type enum onto edges; the schema-mapping doc maps everything
                // to 'pattern' for Phase 6, so a `type` filter equal to
                // 'pattern' is a no-op and any other type returns []).
                if (type && type !== 'pattern') return []
                return grResults
            }
        }
    }

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
        // Cosine similarity via HNSW index
        const vecStr = `[${vector.join(',')}]`
        const typeClause = type ? sql`AND type = ${type}::memory_type` : sql``
        // Namespace filter: ANY(array) so we can match one or many in a
        // single query without rebuilding the whole statement per namespace.
        const nsArray = sql`ARRAY[${sql.join(resolvedNamespaces.map((n) => sql`${n}`), sql`, `)}]::text[]`

        // Two-phase retrieval: hot tier entries ranked first, then by similarity.
        // CASE sorts hot=0, active=1, cold=2 so hot bubbles up within the same similarity band.
        const rows = await db.execute<{
            id: string
            workspace_id: string
            type: string
            content: string
            metadata: Record<string, unknown>
            shorthand: string | null
            tier: string
            namespace: string
            created_at: Date
            similarity: number
        }>(sql`
      SELECT id, workspace_id, type, content, shorthand, metadata, tier, namespace, created_at,
             1 - (embedding <=> ${vecStr}::vector) AS similarity
      FROM memory_entries
      WHERE workspace_id = ${workspaceId}::uuid
        AND embedding IS NOT NULL
        AND tier != 'cold'
        AND namespace = ANY(${nsArray})
        ${typeClause}
      ORDER BY
        CASE tier WHEN 'hot' THEN 0 WHEN 'active' THEN 1 ELSE 2 END ASC,
        embedding <=> ${vecStr}::vector ASC
      LIMIT ${limit}
    `)

        results = rows.map((r) => ({
            id: r.id,
            workspaceId: r.workspace_id,
            type: r.type as MemoryType,
            content: r.content,
            shorthand: r.shorthand ?? undefined,
            metadata: r.metadata,
            tier: (r.tier ?? 'active') as MemoryTier,
            namespace: r.namespace ?? DEFAULT_NAMESPACE,
            createdAt: r.created_at,
            similarity: r.similarity,
        }))
        // Promote retrieved entries to hot tier (non-blocking)
        promoteTier(results.map((r) => r.id))
    } else {
        // Text fallback — ILIKE search when no embedding available, or just recent if query is empty
        const conditions: NonNullable<Parameters<typeof and>[0]>[] = [
            eq(memoryEntries.workspaceId, workspaceId),
            ne(memoryEntries.tier, 'cold'),
            inArray(memoryEntries.namespace, resolvedNamespaces),
        ]

        if (query?.trim()) {
            conditions.push(sql`content ILIKE ${'%' + query.split(' ').slice(0, 5).join('%') + '%'}`)
        }

        if (type) conditions.push(eq(memoryEntries.type, type))

        const rows = await db.select().from(memoryEntries)
            .where(and(...conditions))
            .orderBy(desc(memoryEntries.createdAt))
            .limit(limit)

        results = rows.map((r) => ({
            id: r.id,
            workspaceId: r.workspaceId,
            type: r.type,
            content: r.content,
            shorthand: r.shorthand ?? undefined,
            metadata: r.metadata as Record<string, unknown>,
            tier: (r.tier ?? 'active') as MemoryTier,
            namespace: (r as { namespace?: string }).namespace ?? DEFAULT_NAMESPACE,
            createdAt: r.createdAt,
            similarity: 0.5, // unknown without vector
        }))
        // Promote retrieved entries to hot tier (non-blocking)
        promoteTier(results.map((r) => r.id))
    }

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

    const { getWriteBackend, shouldWritePostgres, shouldMirrorGraphiti, mirrorToGraphiti } = await import('./write-backend.js')
    const backend = getWriteBackend()

    if (shouldMirrorGraphiti(backend)) {
        void mirrorToGraphiti({
            workspaceId: rest.workspaceId,
            content: rest.content,
            sourceDescription: `app:plexo|src:writeShared|ns:${SHARED_NAMESPACE}`,
            name: `shared-${id.slice(0, 8)}`,
            metadata: { ...mergedMetadata, type: rest.type, tier: rest.tier ?? 'active' },
        })
    }

    if (!shouldWritePostgres(backend)) {
        void invalidateSearchCache(rest.workspaceId)
        return id
    }

    await db.insert(memoryEntries).values({
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
            await db.update(memoryEntries)
                .set({ shorthand })
                .where(eq(memoryEntries.id, id))
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
                const vecStr = `[${vector.join(',')}]`
                await db.execute(
                    sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`,
                )
            }
        } catch (err) {
            logger.error({ err, id }, 'Failed to embed shared pattern/note synchronously')
        }
    } else {
        embed(rest.content, rest.workspaceId, rest.aiSettings).then(async (vector) => {
            if (!vector) return
            const vecStr = `[${vector.join(',')}]`
            await db.execute(
                sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`,
            )
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
