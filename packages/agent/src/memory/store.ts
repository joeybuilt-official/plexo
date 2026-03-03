/**
 * Semantic memory — store and retrieve task outcomes with pgvector similarity search.
 *
 * Embedding strategy:
 * - If OPENAI_API_KEY is set: use text-embedding-3-small (1536-dim)
 * - Otherwise: store content without embedding (text-only fallback via ILIKE search)
 *
 * This keeps the system functional without requiring an OpenAI account.
 * Embeddings are generated asynchronously and don't block task completion.
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
    query: string
    type?: MemoryType
    limit?: number
}): Promise<MemorySearchResult[]> {
    const { workspaceId, query, type, limit = 5 } = params

    const vector = await embed(query)

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

        return rows.map((r) => ({
            id: r.id,
            workspaceId: r.workspace_id,
            type: r.type as MemoryType,
            content: r.content,
            metadata: r.metadata,
            createdAt: r.created_at,
            similarity: r.similarity,
        }))
    }

    // Text fallback — ILIKE search when no embedding available
    const conditions = [
        eq(memoryEntries.workspaceId, workspaceId),
        sql`content ILIKE ${'%' + query.split(' ').slice(0, 5).join('%') + '%'}`,
    ]
    if (type) conditions.push(eq(memoryEntries.type, type))

    const rows = await db.select().from(memoryEntries)
        .where(and(...conditions))
        .orderBy(desc(memoryEntries.createdAt))
        .limit(limit)

    return rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        type: r.type,
        content: r.content,
        metadata: r.metadata as Record<string, unknown>,
        createdAt: r.createdAt,
        similarity: 0.5, // unknown without vector
    }))
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
