/**
 * Memory consolidation integration tests — real Postgres, no mocks.
 *
 * `consolidation.ts` is one of the two files left in batch 4 of the memory
 * port extraction, and it was the least-covered code on that path: its whole
 * substance is a data-modifying CTE that inserts a summary and deletes the
 * rows it summarizes in one statement. That atomicity cannot be observed
 * through a mocked `db`, so these tests characterize the real behaviour
 * before the port extraction moves the SQL behind an interface.
 *
 * Every test gets its own workspace. `maybeConsolidate` counts and deletes
 * per workspace, so the file is safe under the suite's parallel forks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@plexo/db'
import { sql } from 'drizzle-orm'
import { maybeConsolidate } from '../../packages/agent/src/memory/consolidation.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Mirrors CONSOLIDATION_THRESHOLD in consolidation.ts. */
const THRESHOLD = 50
/** Mirrors MAX_MEMORIES_PER_CONSOLIDATED in consolidation.ts. */
const MAX_SUMMARIZED = 20

let userId: string
const workspaceIds: string[] = []

function daysAgo(n: number): Date {
    return new Date(Date.now() - n * DAY_MS)
}

/** A workspace of its own, so parallel forks and sibling tests cannot collide. */
async function makeWorkspace(label: string): Promise<string> {
    const id = crypto.randomUUID()
    await db.execute(sql`
        INSERT INTO workspaces (id, name, owner_id, settings)
        VALUES (${id}::uuid, ${`Consolidation ${label}`}, ${userId}::uuid, '{}'::jsonb)
    `)
    workspaceIds.push(id)
    return id
}

/**
 * Seed `count` task memories that all share one instant, which guarantees they
 * land in the same ISO week — the unit consolidation groups by. Markers are
 * `${prefix}-N` so a summary can be checked for which contents survived.
 */
async function seedMemories(
    workspaceId: string,
    count: number,
    createdAt: Date,
    prefix: string,
    type = 'task',
): Promise<void> {
    await db.execute(sql`
        INSERT INTO memory_entries (workspace_id, type, content, metadata, created_at)
        SELECT ${workspaceId}::uuid, ${type}::memory_type, ${prefix} || '-' || g, '{}'::jsonb,
               ${createdAt.toISOString()}::timestamp
        FROM generate_series(1, ${count}) g
    `)
}

async function rowsIn(workspaceId: string): Promise<{ content: string, metadata: Record<string, unknown> }[]> {
    return db.execute<{ content: string, metadata: Record<string, unknown> }>(sql`
        SELECT content, metadata FROM memory_entries WHERE workspace_id = ${workspaceId}::uuid
    `)
}

beforeAll(async () => {
    userId = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await db.execute(sql`
        INSERT INTO users (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
        VALUES (${userId}::uuid, 'Consolidation Test User', ${`consolidation-${Date.now()}@plexo.test`},
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

describe('memory consolidation — integration', () => {
    it('does nothing below the threshold, however old the memories are', async () => {
        const ws = await makeWorkspace('below-threshold')
        await seedMemories(ws, THRESHOLD - 1, daysAgo(90), 'old')

        const result = await maybeConsolidate(ws)

        expect(result.consolidated).toBe(0)
        expect(await rowsIn(ws)).toHaveLength(THRESHOLD - 1)
    })

    it('consolidates each ISO week into its own summary and deletes the originals', async () => {
        const ws = await makeWorkspace('three-weeks')
        // 14 days apart, so each lands in a distinct ISO week. All three are
        // within MAX_SUMMARIZED, so each week folds in a single pass.
        await seedMemories(ws, 20, daysAgo(90), 'weekA')
        await seedMemories(ws, 18, daysAgo(76), 'weekB')
        await seedMemories(ws, 15, daysAgo(62), 'weekC')

        const result = await maybeConsolidate(ws)

        expect(result.consolidated).toBe(53)

        const rows = await rowsIn(ws)
        // One summary per week and nothing else: the DELETE half of the CTE ran.
        expect(rows).toHaveLength(3)
        expect(rows.every((r) => r.metadata.consolidated === true)).toBe(true)
        expect(rows.map((r) => r.metadata.sourceCount).sort((a, b) => Number(a) - Number(b)))
            .toEqual([15, 18, 20])
        expect(rows.some((r) => /^week[ABC]-\d+$/.test(r.content))).toBe(false)
    })

    it('leaves a week holding a single memory alone', async () => {
        const ws = await makeWorkspace('singleton')
        await seedMemories(ws, THRESHOLD, daysAgo(90), 'bulk')
        await seedMemories(ws, 1, daysAgo(200), 'lonely') // its own ISO week, on its own

        const result = await maybeConsolidate(ws)

        // The bulk week folds one capped batch; the singleton week is skipped.
        expect(result.consolidated).toBe(MAX_SUMMARIZED)
        expect((await rowsIn(ws)).map((r) => r.content)).toContain('lonely-1')
    })

    it('leaves memories inside the 30-day window alone', async () => {
        const ws = await makeWorkspace('recent')
        // 45 old across three weeks, each within the cap, plus 5 recent — 50 in
        // total, which is what trips the threshold.
        await seedMemories(ws, 15, daysAgo(90), 'old')
        await seedMemories(ws, 15, daysAgo(76), 'old')
        await seedMemories(ws, 15, daysAgo(62), 'old')
        await seedMemories(ws, 5, daysAgo(2), 'recent')

        const result = await maybeConsolidate(ws)

        expect(result.consolidated).toBe(45)
        const survivors = (await rowsIn(ws)).map((r) => r.content).filter((c) => c.startsWith('recent-'))
        expect(survivors).toHaveLength(5)
    })

    it('never consolidates pattern memories', async () => {
        const ws = await makeWorkspace('patterns')
        await seedMemories(ws, THRESHOLD, daysAgo(90), 'task')
        await seedMemories(ws, 10, daysAgo(90), 'pattern', 'pattern')

        await maybeConsolidate(ws)

        const patterns = (await rowsIn(ws)).filter((r) => r.content.startsWith('pattern-'))
        expect(patterns).toHaveLength(10)
    })

    it('deletes only what it summarized when a week exceeds the fold cap', async () => {
        // The invariant that matters: a memory is destroyed only once its
        // content is inside a summary. Before the fix this week lost the text
        // of everything past the 20th entry — the summary was capped while the
        // delete set was not.
        const ws = await makeWorkspace('over-cap')
        const OVER_CAP = 30
        await seedMemories(ws, OVER_CAP, daysAgo(90), 'capA')
        await seedMemories(ws, 25, daysAgo(76), 'capB') // only here to trip the threshold

        await maybeConsolidate(ws)

        const rows = await rowsIn(ws)
        // Surviving originals also contain 'capA-', so match on the summary marker.
        const summary = rows.find((r) => r.metadata.consolidated === true && r.content.includes('capA-'))
        expect(summary).toBeDefined()
        expect(summary!.metadata.sourceCount).toBe(MAX_SUMMARIZED)

        const all = Array.from({ length: OVER_CAP }, (_, i) => `capA-${i + 1}`)
        const summarized = all.filter((m) => new RegExp(`(^|\\n)${m}($|\\n)`).test(summary!.content))
        const survivors = rows.map((r) => r.content).filter((c) => all.includes(c))

        expect(summarized).toHaveLength(MAX_SUMMARIZED)
        expect(survivors).toHaveLength(OVER_CAP - MAX_SUMMARIZED)
        // Disjoint, and together they account for every seeded memory: nothing
        // was deleted without first being folded into the summary.
        expect(summarized.filter((m) => survivors.includes(m))).toHaveLength(0)
        expect(new Set([...summarized, ...survivors]).size).toBe(OVER_CAP)
    })
})
