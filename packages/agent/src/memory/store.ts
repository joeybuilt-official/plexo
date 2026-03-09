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
import { db, eq, and, desc, sql } from '@plexo/db'
import { memoryEntries } from '@plexo/db'

const logger = pino({ name: 'memory' })

export type MemoryType = 'task' | 'incident' | 'session' | 'pattern'

export interface MemoryEntry {
    id: string
    workspaceId: string
    type: MemoryType
    content: string
    metadata: Record<string, unknown>
    createdAt: Date
}

export interface MemorySearchResult extends MemoryEntry {
    similarity: number
}

// ── Redis client (lazy singleton) ─────────────────────────────────────────────
// Imports dynamically so this module loads without Redis in test/local envs.

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
        const keys: string[] = await redis.keys(pattern)
        if (keys.length > 0) await redis.del(keys)
    } catch { /* non-fatal */ }
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[] | null> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return null

    try {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'text-embedding-3-small',
                input: text.slice(0, 8192), // token limit
                dimensions: 1536,
            }),
        })

        if (!res.ok) {
            logger.warn({ status: res.status }, 'Embedding API returned non-200')
            return null
        }

        const data = await res.json() as { data: [{ embedding: number[] }] }
        return data.data[0]?.embedding ?? null
    } catch (err) {
        logger.warn({ err }, 'Embedding failed — storing without vector')
        return null
    }
}

// ── Store ─────────────────────────────────────────────────────────────────────

export async function storeMemory(params: {
    workspaceId: string
    type: MemoryType
    content: string
    metadata?: Record<string, unknown>
}): Promise<string> {
    const { workspaceId, type, content, metadata = {} } = params

    const id = crypto.randomUUID()

    // Insert without embedding first (non-blocking)
    await db.insert(memoryEntries).values({
        id,
        workspaceId,
        type,
        content,
        metadata,
    })

    // Invalidate search cache on every write
    void invalidateSearchCache(workspaceId)

    // Generate embedding async — don't await in hot path
    embed(content).then(async (vector) => {
        if (!vector) return
        const vecStr = `[${vector.join(',')}]`
        // Raw SQL for vector column (Drizzle doesn't support vector type natively)
        await db.execute(
            sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`,
        )
    }).catch((err) => logger.error({ err, id }, 'Failed to update embedding'))

    return id
}

// ── Retrieve: semantic search ─────────────────────────────────────────────────

export async function searchMemory(params: {
    workspaceId: string
    query?: string
    type?: MemoryType
    limit?: number
    useCache?: boolean
}): Promise<MemorySearchResult[]> {
    const { workspaceId, query, type, limit = 5, useCache = true } = params

    // Check Redis cache first
    if (useCache) {
        try {
            const redis = await getRedis()
            if (redis) {
                const cached = await redis.get(searchKey(workspaceId, query || '', type))
                if (cached) {
                    return JSON.parse(cached) as MemorySearchResult[]
                }
            }
        } catch { /* non-fatal */ }
    }

    const vector = query?.trim() ? await embed(query) : null
    let results: MemorySearchResult[]

    if (vector) {
        // Cosine similarity via HNSW index
        const vecStr = `[${vector.join(',')}]`
        const typeClause = type ? sql`AND type = ${type}::memory_type` : sql``

        const rows = await db.execute<{
            id: string
            workspace_id: string
            type: string
            content: string
            metadata: Record<string, unknown>
            created_at: Date
            similarity: number
        }>(sql`
      SELECT id, workspace_id, type, content, metadata, created_at,
             1 - (embedding <=> ${vecStr}::vector) AS similarity
      FROM memory_entries
      WHERE workspace_id = ${workspaceId}::uuid
        AND embedding IS NOT NULL
        ${typeClause}
      ORDER BY embedding <=> ${vecStr}::vector
      LIMIT ${limit}
    `)

        results = rows.map((r) => ({
            id: r.id,
            workspaceId: r.workspace_id,
            type: r.type as MemoryType,
            content: r.content,
            metadata: r.metadata,
            createdAt: r.created_at,
            similarity: r.similarity,
        }))
    } else {
        // Text fallback — ILIKE search when no embedding available, or just recent if query is empty
        const conditions: NonNullable<Parameters<typeof and>[0]>[] = [
            eq(memoryEntries.workspaceId, workspaceId)
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
            metadata: r.metadata as Record<string, unknown>,
            createdAt: r.createdAt,
            similarity: 0.5, // unknown without vector
        }))
    }

    // Write to cache
    if (useCache && results.length > 0) {
        try {
            const redis = await getRedis()
            if (redis) {
                await redis.setEx(searchKey(workspaceId, query || '', type), SEARCH_TTL, JSON.stringify(results))
            }
        } catch { /* non-fatal */ }
    }

    return results
}

// ── Record task outcome as memory ─────────────────────────────────────────────

export async function recordTaskMemory(params: {
    workspaceId: string
    taskId: string
    description: string
    outcome: 'success' | 'failure' | 'partial'
    toolsUsed: string[]
    qualityScore?: number
    durationMs?: number
    notes?: string
}): Promise<void> {
    const { workspaceId, taskId, description, outcome, toolsUsed, qualityScore, durationMs, notes } = params

    const content = [
        `Task: ${description}`,
        `Outcome: ${outcome}`,
        `Tools: ${toolsUsed.join(', ')}`,
        qualityScore != null ? `Quality: ${qualityScore.toFixed(2)}` : '',
        notes ? `Notes: ${notes}` : '',
    ].filter(Boolean).join('\n')

    await storeMemory({
        workspaceId,
        type: 'task',
        content,
        metadata: { taskId, outcome, toolsUsed, qualityScore, durationMs },
    })

    logger.debug({ taskId, outcome, workspaceId }, 'Task memory recorded')
}

// ── Direct user-instruction memory write ─────────────────────────────────────
// Called when chat detects "remember X" / "always do Y" intent.

export async function rememberInstruction(params: {
    workspaceId: string
    instruction: string
    source?: 'chat' | 'api' | 'telegram'
}): Promise<string> {
    const { workspaceId, instruction, source = 'chat' } = params

    const id = await storeMemory({
        workspaceId,
        type: 'pattern',
        content: instruction,
        metadata: {
            source,
            userInstruction: true,
            recordedAt: new Date().toISOString(),
        },
    })

    // Also invalidate prefs cache since this may affect behavior
    try {
        const redis = await getRedis()
        if (redis) await redis.del(prefKey(workspaceId))
    } catch { /* non-fatal */ }

    logger.info({ workspaceId, source }, 'User instruction stored to memory')
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
