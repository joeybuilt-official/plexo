/**
 * Memory pipeline integration tests — full store → shorthand → embedding → search.
 * Runs against local dev Postgres (DATABASE_URL set in tests/setup.ts).
 *
 * LLM/embedding calls are mocked so the test works in CI without Ollama.
 * The mocks simulate realistic shorthand + embedding output so we validate
 * the full pipeline path including vector search.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { db } from '@plexo/db'
import { eq, sql } from 'drizzle-orm'
import { workspaces, memoryEntries } from '@plexo/db'
import { type WorkspaceAISettings } from '../../packages/domain/src/ai-settings.js'

// ── Mock LLM (shorthand) + embedding before importing store ────────────────

// Deterministic fake embedding: feature-hash the words into a 384-dim unit
// vector, one dimension per token. memory_entries.embedding is vector(384)
// (retyped from 1536 in migration 0065).
//
// Token-level hashing matters: an earlier version hashed the whole string into
// every dimension, so two texts sharing a word still came out near-orthogonal
// (measured cosine -0.083 for "church calling" against a document containing
// "church"). That makes any similarity assertion meaningless. Hashing per token
// gives shared vocabulary a shared direction, which is the one property of a
// real embedder this pipeline depends on.
function fakeEmbedding(text: string): number[] {
    const vec = new Array<number>(384).fill(0)
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 0
        for (let i = 0; i < token.length; i++) {
            h = ((h << 5) - h + token.charCodeAt(i)) | 0
        }
        vec[Math.abs(h) % 384] += 1
    }
    const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0))
    return mag === 0 ? vec : vec.map((v: number) => v / mag)
}

// Mock the embedding router — intercepts before store.ts loads it
vi.mock('../../packages/agent/src/embeddings/router.js', () => ({
    resolveEmbeddingAdapterAsync: vi.fn().mockResolvedValue({
        adapter: { embed: (text: string) => Promise.resolve(fakeEmbedding(text)) },
        status: 'active',
        providerId: 'test-mock',
    }),
}))

// Mock the router — `summarizeMemory` reaches the model only through
// `routeAndCall`, so that is the seam this test controls, and the mock returns
// the shorthand directly instead of invoking `doCall`.
//
// It must NOT delegate to `doCall`: the `ai` package is a dependency of
// packages/agent and has no root-level install, so a `vi.mock('ai', ...)` in a
// test under tests/ resolves nothing and silently never binds. The previous
// version of this file did exactly that, so `doCall` reached the real AI SDK,
// failed with "Unauthenticated request to AI Gateway", and left shorthand null.
vi.mock('../../packages/agent/src/providers/router-v2/index.js', () => ({
    routeAndCall: vi.fn().mockResolvedValue(
        'F: LDS bishop, Utah, near Utah Valley Hospital\nP: respect religious context\nS: bishop near hospital Utah',
    ),
}))

// Empty mock — store.ts only type-imports registry.js. This stays to satisfy
// any registry imports that linger via dynamic require (matches store.test.ts).
vi.mock('../../packages/agent/src/providers/registry.js', () => ({}))

// Now import the functions under test (after mocks are registered)
const { storeMemory, searchMemory } = await import('../../packages/agent/src/memory/store.js')

// ── Test fixtures ──────────────────────────────────────────────────────────

let workspaceId: string
let userId: string
let storedMemoryId: string

// Non-empty aiSettings is required for summarizeMemory to attempt LLM
// shorthand generation at all (store.ts skips it entirely when absent).
// routeAndCall is mocked above, so provider/model resolution never runs.
const aiSettings: WorkspaceAISettings = {
    primaryProvider: 'openai',
    fallbackChain: [],
    providers: {},
}

beforeAll(async () => {
    const ts = Date.now().toString(16).padEnd(8, '0')
    userId = `00000000-0000-4000-8000-${ts.padStart(12, '0')}`
    workspaceId = `00000000-0000-4000-a000-${ts.padStart(12, '0')}`

    const nowIso = new Date().toISOString()
    await db.execute(sql`
        INSERT INTO users (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
        VALUES (${userId}, 'Memory Pipeline Test User', ${`memory-test-${ts}@plexo.test`}, true, ${nowIso}::timestamptz, ${nowIso}::timestamptz, 'member')
        ON CONFLICT (id) DO NOTHING
    `).catch(() => { /* FDW may not be configured in test env */ })

    await db.insert(workspaces).values({
        id: workspaceId,
        name: 'Memory Pipeline Test Workspace',
        ownerId: userId,
        settings: {},
    }).onConflictDoNothing()
})

afterAll(async () => {
    // Clean up test data
    await db.delete(memoryEntries).where(eq(memoryEntries.workspaceId, workspaceId)).catch(() => {})
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId)).catch(() => {})
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => {})
})

describe('memory pipeline — integration', () => {
    it('storeMemory inserts a row and returns a UUID', async () => {
        // type: 'pattern' is the only MemoryType that awaits its embedding
        // synchronously in storeMemory — 'session' enqueues a fire-and-forget
        // Inngest job that never runs in this test process.
        storedMemoryId = await storeMemory({
            workspaceId,
            type: 'pattern',
            content: 'User is a bishop in the LDS church living in Utah near Utah Valley Hospital',
            aiSettings,
        })

        expect(storedMemoryId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        )
    })

    it('memory row exists in DB with correct content', async () => {
        const rows = await db
            .select()
            .from(memoryEntries)
            .where(eq(memoryEntries.id, storedMemoryId))

        expect(rows).toHaveLength(1)
        expect(rows[0].content).toContain('bishop')
        expect(rows[0].content).toContain('Utah Valley Hospital')
        expect(rows[0].type).toBe('pattern')
        expect(rows[0].workspaceId).toBe(workspaceId)
        expect(rows[0].tier).toBe('active')
    })

    it('shorthand was generated (not null)', async () => {
        const rows = await db
            .select({ shorthand: memoryEntries.shorthand })
            .from(memoryEntries)
            .where(eq(memoryEntries.id, storedMemoryId))

        expect(rows).toHaveLength(1)
        expect(rows[0].shorthand).not.toBeNull()
        expect(rows[0].shorthand!.length).toBeGreaterThan(0)
        // Shorthand should contain compressed facts from the mock
        expect(rows[0].shorthand).toContain('LDS')
    })

    it('embedding was generated (vector column populated)', async () => {
        // No delay needed — type: 'pattern' awaits the embedding write
        // synchronously inside storeMemory before it returns.
        const rows = await db.execute<{ has_embedding: boolean }>(
            sql`SELECT embedding IS NOT NULL AS has_embedding FROM memory_entries WHERE id = ${storedMemoryId}::uuid`,
        )

        expect(rows).toHaveLength(1)
        expect(rows[0].has_embedding).toBe(true)
    })

    it('searchMemory finds the entry with query "church calling"', async () => {
        const results = await searchMemory({
            workspaceId,
            query: 'church calling',
            useCache: false,
        })

        expect(results.length).toBeGreaterThanOrEqual(1)
        const match = results.find((r) => r.id === storedMemoryId)
        expect(match).toBeDefined()
        expect(match!.content).toContain('bishop')
        expect(match!.similarity).toBeGreaterThan(0)
    })

    it('searchMemory finds the entry with query "Utah hospital"', async () => {
        const results = await searchMemory({
            workspaceId,
            query: 'Utah hospital',
            useCache: false,
        })

        expect(results.length).toBeGreaterThanOrEqual(1)
        const match = results.find((r) => r.id === storedMemoryId)
        expect(match).toBeDefined()
        expect(match!.content).toContain('Utah Valley Hospital')
    })

    it('searchMemory respects type filter', async () => {
        const results = await searchMemory({
            workspaceId,
            query: 'church',
            type: 'task', // wrong type — should not find our 'pattern' entry
            useCache: false,
        })

        const match = results.find((r) => r.id === storedMemoryId)
        expect(match).toBeUndefined()
    })

    it('searchMemory with no query returns recent entries', async () => {
        const results = await searchMemory({
            workspaceId,
            useCache: false,
        })

        expect(results.length).toBeGreaterThanOrEqual(1)
        const match = results.find((r) => r.id === storedMemoryId)
        expect(match).toBeDefined()
    })
})
