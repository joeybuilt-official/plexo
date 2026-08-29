/**
 * quarantinePoorRules integration test — real Postgres.
 *
 * The quarantine UPDATE bound its key list as `ANY(${toQuarantine}::text[])`,
 * which Drizzle renders as a ROW constructor and Postgres rejects. The failure
 * went into `.catch(() => null)` and the function then reported
 * `quarantinedCount = toQuarantine.length` regardless — so it logged
 * "Quarantined poor-performing rules" having quarantined none.
 *
 * This pins both halves: the statement runs, and the count reflects rows the
 * UPDATE actually changed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@plexo/db'
import { sql } from 'drizzle-orm'
import { quarantinePoorRules } from '../../packages/agent/src/domain-mastery/credit-assignment.js'

let userId: string
const workspaceIds: string[] = []

async function makeWorkspace(label: string): Promise<string> {
    const id = crypto.randomUUID()
    await db.execute(sql`
        INSERT INTO workspaces (id, name, owner_id, settings)
        VALUES (${id}::uuid, ${`Quarantine ${label}`}, ${userId}::uuid, '{}'::jsonb)
    `)
    workspaceIds.push(id)
    return id
}

async function makeRule(workspaceId: string, key: string, opts: { tags?: string[], deleted?: boolean } = {}) {
    const tags = opts.tags ?? []
    await db.execute(sql`
        INSERT INTO behavior_rules (workspace_id, type, key, label, value, tags, deleted_at)
        VALUES (${workspaceId}::uuid, 'operational_rule'::rule_type, ${key}, ${key},
                '{}'::jsonb, ${sql`ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`},
                ${opts.deleted ? sql`NOW()` : sql`NULL`})
    `)
}

/** Three recent below-average credit observations is what trips the quarantine. */
async function makePoorObservations(workspaceId: string, sourceRef: string) {
    await db.execute(sql`
        INSERT INTO learning_events (workspace_id, event_type, source_surface, shareable, source_ref, quality_context, created_at)
        SELECT ${workspaceId}::uuid, 'credit_observation', 'test', false, ${sourceRef}, 0.1, NOW() - (g || ' hours')::interval
        FROM generate_series(1, 3) g
    `)
}

async function tagsOf(workspaceId: string, key: string): Promise<string[]> {
    const [row] = await db.execute<{ tags: string[] }>(sql`
        SELECT tags FROM behavior_rules WHERE workspace_id = ${workspaceId}::uuid AND key = ${key}
    `)
    return row?.tags ?? []
}

beforeAll(async () => {
    userId = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await db.execute(sql`
        INSERT INTO users (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
        VALUES (${userId}::uuid, 'Quarantine Test User', ${`quarantine-${Date.now()}@plexo.test`},
                true, ${nowIso}::timestamptz, ${nowIso}::timestamptz, 'member')
    `)
})

afterAll(async () => {
    for (const id of workspaceIds) {
        await db.execute(sql`DELETE FROM learning_events WHERE workspace_id = ${id}::uuid`).catch(() => {})
        await db.execute(sql`DELETE FROM behavior_rules WHERE workspace_id = ${id}::uuid`).catch(() => {})
        await db.execute(sql`DELETE FROM workspaces WHERE id = ${id}::uuid`).catch(() => {})
    }
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}::uuid`).catch(() => {})
})

describe('quarantinePoorRules — integration', () => {
    it('tags a consistently poor rule and reports it', async () => {
        const ws = await makeWorkspace('tags')
        await makeRule(ws, 'poor-rule')
        await makePoorObservations(ws, 'poor-rule')

        const result = await quarantinePoorRules(ws)

        expect(result.quarantinedCount).toBe(1)
        expect(await tagsOf(ws, 'poor-rule')).toContain('quarantined')
    })

    it('counts rows it actually changed, not candidates it found', async () => {
        // Both rules look poor, but one is already quarantined and one is
        // soft-deleted — the UPDATE matches neither. The old code returned 2.
        const ws = await makeWorkspace('honest-count')
        await makeRule(ws, 'already-quarantined', { tags: ['quarantined'] })
        await makeRule(ws, 'soft-deleted', { deleted: true })
        await makePoorObservations(ws, 'already-quarantined')
        await makePoorObservations(ws, 'soft-deleted')

        const result = await quarantinePoorRules(ws)

        expect(result.quarantinedCount).toBe(0)
    })

    it('leaves a workspace with no poor rules alone', async () => {
        const ws = await makeWorkspace('clean')
        await makeRule(ws, 'good-rule')

        const result = await quarantinePoorRules(ws)

        expect(result.quarantinedCount).toBe(0)
        expect(await tagsOf(ws, 'good-rule')).not.toContain('quarantined')
    })
})
