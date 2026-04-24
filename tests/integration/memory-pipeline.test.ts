/**
 * Memory pipeline integration tests — full store → shorthand → embedding → search.
 * Runs against local dev Postgres (DATABASE_URL set in tests/setup.ts).
 *
 * LLM/embedding calls are mocked so the test works in CI without Ollama.
 * The mocks simulate realistic shorthand + embedding output so we validate
 * the full pipeline path including vector search.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { db, eq, sql } from '@plexo/db'
import { workspaces, memoryEntries } from '@plexo/db'

// ── Mock LLM (shorthand) + embedding before importing store ────────────────

// Deterministic fake embedding: hash string into a 1536-dim unit vector.
function fakeEmbedding(text: string): number[] {
    const vec = new Array(1536).fill(0)
    let h = 0
    for (let i = 0; i < text.length; i++) {
        h = ((h << 5) - h + text.charCodeAt(i)) | 0
    }
    // Spread energy across dimensions based on hash
    for (let i = 0; i < 1536; i++) {
        h = ((h << 5) - h + i) | 0
        vec[i] = Math.sin(h)
    }
    // Normalize
    const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0))
    return vec.map((v: number) => v / mag)
}

// Mock the embedding router — intercepts before store.ts loads it
vi.mock('../../packages/agent/src/embeddings/router.js', () => ({
    resolveEmbeddingAdapterAsync: vi.fn().mockResolvedValue({
        adapter: { embed: (text: string) => Promise.resolve(fakeEmbedding(text)) },
        status: 'active',
        providerId: 'test-mock',
    }),
}))

// Mock the AI SDK generateText — intercepts shorthand generation
vi.mock('ai', () => ({
    generateText: vi.fn().mockResolvedValue({
        text: 'F: LDS bishop, Utah, near Utah Valley Hospital\nP: respect religious context\nS: bishop near hospital Utah',
    }),
}))

// Mock the provider registry so it doesn't try to resolve real API keys
vi.mock('../../packages/agent/src/providers/registry.js', () => ({
    resolveModelFromEnv: vi.fn().mockReturnValue('mock-model'),
    withFallback: vi.fn().mockImplementation(
        async (_settings: unknown, _task: unknown, fn: (model: string) => Promise<string>) => fn('mock-model'),
    ),
}))

// Now import the functions under test (after mocks are registered)
const { storeMemory, searchMemory } = await import('../../packages/agent/src/memory/store.js')

// ── Test fixtures ──────────────────────────────────────────────────────────

let workspaceId: string
let userId: string
let storedMemoryId: string

beforeAll(async () => {
    const ts = Date.now().toString(16).padEnd(8, '0')
    userId = `00000000-0000-4000-8000-${ts.padStart(12, '0')}`
    workspaceId = `00000000-0000-4000-a000-${ts.padStart(12, '0')}`

    const nowIso = new Date().toISOString()
    await db.execute(sql`
        INSERT INTO users (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
        VALUES (${userId}, 'Memory Pipeline Test User', ${`memory-test-${ts}@plexo.test`}, true, ${nowIso}::timestamptz, ${nowIso}::timestamptz, 'user')
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
        storedMemoryId = await storeMemory({
            workspaceId,
            type: 'session',
            content: 'User is a bishop in the LDS church living in Utah near Utah Valley Hospital',
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
        expect(rows[0].type).toBe('session')
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
        // Small delay — embedding write is fire-and-forget in storeMemory
        await new Promise((r) => setTimeout(r, 500))

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
            type: 'task', // wrong type — should not find our 'session' entry
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
