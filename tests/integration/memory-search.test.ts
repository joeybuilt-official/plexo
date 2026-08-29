/**
 * searchMemory integration tests — real Postgres + pgvector, no mocked db.
 *
 * `store.ts` is the least-covered, highest-blast-radius file on the memory
 * path, and the expert panel's condition for extracting it behind a repository
 * port was real tests under the pgvector path first. This is that coverage: it
 * pins the retrieval semantics the port must preserve — workspace isolation,
 * namespace resolution, the cold-tier exclusion, hot-before-active ordering,
 * the type filter, the limit, and the null-embedding exclusion.
 *
 * Only the embedding provider is faked. The vector column, the HNSW distance
 * operator and the ORDER BY are the real thing, because they are the part a
 * port extraction can silently change.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { db } from '@plexo/db'
import { sql } from 'drizzle-orm'

/**
 * Feature-hashed bag of words, one dimension per token, so texts that share
 * vocabulary share direction. memory_entries.embedding is vector(384).
 */
function fakeEmbedding(text: string): number[] {
    const vec = new Array<number>(384).fill(0)
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 0
        for (let i = 0; i < token.length; i++) h = ((h << 5) - h + token.charCodeAt(i)) | 0
        vec[Math.abs(h) % 384] += 1
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
    return mag === 0 ? vec : vec.map((v) => v / mag)
}

vi.mock('../../packages/agent/src/embeddings/router.js', () => ({
    resolveEmbeddingAdapterAsync: vi.fn().mockResolvedValue({
        adapter: { embed: (text: string) => Promise.resolve(fakeEmbedding(text)) },
        status: 'active',
        providerId: 'test-mock',
    }),
}))

const { searchMemory } = await import('../../packages/agent/src/memory/store.js')

let userId: string
const workspaceIds: string[] = []

async function makeWorkspace(label: string): Promise<string> {
    const id = crypto.randomUUID()
    await db.execute(sql`
        INSERT INTO workspaces (id, name, owner_id, settings)
        VALUES (${id}::uuid, ${`Search ${label}`}, ${userId}::uuid, '{}'::jsonb)
    `)
    workspaceIds.push(id)
    return id
}

/** Insert one row with full control over tier, namespace and embedding. */
async function insertMemory(opts: {
    workspaceId: string
    content: string
    type?: string
    tier?: string
    namespace?: string
    embed?: boolean
}): Promise<string> {
    const { workspaceId, content, type = 'pattern', tier = 'active', namespace = 'default', embed = true } = opts
    const [row] = await db.execute<{ id: string }>(sql`
        INSERT INTO memory_entries (workspace_id, type, content, metadata, tier, namespace)
        VALUES (${workspaceId}::uuid, ${type}::memory_type, ${content}, '{}'::jsonb, ${tier}, ${namespace})
        RETURNING id
    `)
    if (embed) {
        const vec = `[${fakeEmbedding(content).join(',')}]`
        await db.execute(sql`UPDATE memory_entries SET embedding = ${vec}::vector WHERE id = ${row!.id}::uuid`)
    }
    return row!.id
}

async function tierOf(id: string): Promise<string> {
    const [row] = await db.execute<{ tier: string }>(
        sql`SELECT tier FROM memory_entries WHERE id = ${id}::uuid`,
    )
    return row!.tier
}

beforeAll(async () => {
    userId = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await db.execute(sql`
        INSERT INTO users (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
        VALUES (${userId}::uuid, 'Search Test User', ${`search-${Date.now()}@plexo.test`},
                true, ${nowIso}::timestamptz, ${nowIso}::timestamptz, 'member')
    `)
})

afterAll(async () => {
    for (const id of workspaceIds) {
        await db.execute(sql`DELETE FROM memory_entries WHERE workspace_id = ${id}::uuid`).catch(() => {})
        await db.execute(sql`DELETE FROM workspaces WHERE id = ${id}::uuid`).catch(() => {})
    }
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}::uuid`).catch(() => {})
})

describe('searchMemory — vector retrieval semantics', () => {
    it('never returns another workspace\'s memories', async () => {
        const mine = await makeWorkspace('isolation-mine')
        const theirs = await makeWorkspace('isolation-theirs')
        await insertMemory({ workspaceId: mine, content: 'shared vocabulary alpha' })
        await insertMemory({ workspaceId: theirs, content: 'shared vocabulary alpha' })

        const results = await searchMemory({ workspaceId: mine, query: 'shared vocabulary', useCache: false })

        expect(results).toHaveLength(1)
        expect(results[0]!.workspaceId).toBe(mine)
    })

    it('excludes rows with no embedding from the vector path', async () => {
        const ws = await makeWorkspace('null-embedding')
        await insertMemory({ workspaceId: ws, content: 'vector present alpha' })
        await insertMemory({ workspaceId: ws, content: 'vector absent alpha', embed: false })

        const results = await searchMemory({ workspaceId: ws, query: 'vector alpha', useCache: false })

        expect(results.map((r) => r.content)).toEqual(['vector present alpha'])
    })

    it('excludes cold-tier memories', async () => {
        const ws = await makeWorkspace('cold')
        await insertMemory({ workspaceId: ws, content: 'warm entry beta', tier: 'active' })
        await insertMemory({ workspaceId: ws, content: 'frozen entry beta', tier: 'cold' })

        const results = await searchMemory({ workspaceId: ws, query: 'entry beta', useCache: false })

        expect(results.map((r) => r.content)).toEqual(['warm entry beta'])
    })

    it('orders hot-tier entries ahead of active ones', async () => {
        const ws = await makeWorkspace('tier-order')
        // The active row is the closer match by vocabulary; the hot row still
        // sorts first, because tier is the primary key of the ORDER BY.
        await insertMemory({ workspaceId: ws, content: 'gamma delta epsilon', tier: 'active' })
        await insertMemory({ workspaceId: ws, content: 'gamma unrelated', tier: 'hot' })

        const results = await searchMemory({ workspaceId: ws, query: 'gamma delta epsilon', useCache: false })

        expect(results.map((r) => r.content)).toEqual(['gamma unrelated', 'gamma delta epsilon'])
    })

    it('honours the type filter and the limit', async () => {
        const ws = await makeWorkspace('filters')
        await insertMemory({ workspaceId: ws, content: 'zeta one', type: 'pattern' })
        await insertMemory({ workspaceId: ws, content: 'zeta two', type: 'pattern' })
        await insertMemory({ workspaceId: ws, content: 'zeta three', type: 'task' })

        const patterns = await searchMemory({ workspaceId: ws, query: 'zeta', type: 'pattern', useCache: false })
        expect(patterns).toHaveLength(2)

        const limited = await searchMemory({ workspaceId: ws, query: 'zeta', limit: 1, useCache: false })
        expect(limited).toHaveLength(1)
    })
})

describe('searchMemory — namespace resolution', () => {
    it('reads only the default namespace when none is given', async () => {
        const ws = await makeWorkspace('ns-default')
        await insertMemory({ workspaceId: ws, content: 'eta default', namespace: 'default' })
        await insertMemory({ workspaceId: ws, content: 'eta elsewhere', namespace: 'agent-scout' })

        const results = await searchMemory({ workspaceId: ws, query: 'eta', useCache: false })

        expect(results.map((r) => r.content)).toEqual(['eta default'])
    })

    it('reads an explicit namespace, and several at once', async () => {
        const ws = await makeWorkspace('ns-explicit')
        await insertMemory({ workspaceId: ws, content: 'theta default', namespace: 'default' })
        await insertMemory({ workspaceId: ws, content: 'theta scout', namespace: 'agent-scout' })
        await insertMemory({ workspaceId: ws, content: 'theta shared', namespace: 'shared' })

        const one = await searchMemory({ workspaceId: ws, query: 'theta', namespace: 'agent-scout', useCache: false })
        expect(one.map((r) => r.content)).toEqual(['theta scout'])

        const many = await searchMemory({
            workspaceId: ws, query: 'theta', namespaces: ['agent-scout', 'shared'], useCache: false,
        })
        expect(many.map((r) => r.content).sort()).toEqual(['theta scout', 'theta shared'])
    })

    it('spans the agent slice and the shared slice for an agentId', async () => {
        const ws = await makeWorkspace('ns-agent')
        await insertMemory({ workspaceId: ws, content: 'iota own', namespace: 'agent-scout' })
        await insertMemory({ workspaceId: ws, content: 'iota shared', namespace: 'shared' })
        await insertMemory({ workspaceId: ws, content: 'iota other', namespace: 'agent-ranger' })

        const results = await searchMemory({ workspaceId: ws, query: 'iota', agentId: 'scout', useCache: false })

        expect(results.map((r) => r.content).sort()).toEqual(['iota own', 'iota shared'])
    })
})

describe('searchMemory — retrieval promotes to the hot tier', () => {
    it('promotes a returned active entry to hot', async () => {
        // promoteTier is fire-and-forget, so poll rather than assert once.
        // It was also dead until this change: its UPDATE interpolated a JS
        // array into `ANY(${ids}::uuid[])`, which Postgres rejects as a ROW
        // constructor, and the rejection went into an empty `.catch()`.
        const ws = await makeWorkspace('promote')
        const id = await insertMemory({ workspaceId: ws, content: 'kappa promote me', tier: 'active' })

        const results = await searchMemory({ workspaceId: ws, query: 'kappa promote', useCache: false })
        expect(results.map((r) => r.id)).toContain(id)

        let tier = await tierOf(id)
        for (let i = 0; i < 20 && tier !== 'hot'; i++) {
            await new Promise((r) => setTimeout(r, 50))
            tier = await tierOf(id)
        }
        expect(tier).toBe('hot')
    })
})

describe('searchMemory — no query falls back to recent entries', () => {
    it('returns recent entries without a vector search', async () => {
        const ws = await makeWorkspace('no-query')
        await insertMemory({ workspaceId: ws, content: 'lambda one', embed: false })
        await insertMemory({ workspaceId: ws, content: 'lambda two', embed: false })

        const results = await searchMemory({ workspaceId: ws, useCache: false })

        // The text path reports a fixed similarity — it has no vector to score.
        expect(results).toHaveLength(2)
        expect(results.every((r) => r.similarity === 0.5)).toBe(true)
    })
})
