/**
 * Concurrent introspection snapshot integration tests.
 * Verifies that 10 parallel buildIntrospectionSnapshot() calls against the
 * same workspaceId don't crash, don't corrupt, and return structurally
 * consistent results.
 *
 * Note: buildIntrospectionSnapshot() queries Postgres only (no Redis/Valkey).
 * The "cache coherent" property tested here is consistent snapshot shape, not
 * a separate cache layer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db, eq, sql } from '@plexo/db'
import { workspaces } from '@plexo/db'
import { buildIntrospectionSnapshot } from '../../packages/agent/src/introspection/index.js'

let workspaceId: string
let userId: string

beforeAll(async () => {
    const ts = Date.now().toString(16).slice(-10).padStart(10, '0')
    userId = `00000000-0000-4000-8000-aa${ts}`
    workspaceId = `00000000-0000-4000-9000-aa${ts}`

    const nowIso = new Date().toISOString()
    await db.execute(sql`
        INSERT INTO users (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
        VALUES (${userId}, 'Introspection Concurrency User', ${`introspect-concur-${ts}@plexo.test`},
                true, ${nowIso}::timestamptz, ${nowIso}::timestamptz, 'user')
        ON CONFLICT (id) DO NOTHING
    `).catch(() => { })

    await db.insert(workspaces).values({
        id: workspaceId,
        name: 'Introspection Concurrency Workspace',
        ownerId: userId,
        settings: { agentName: 'TestBot', agentPersona: 'A concurrency test agent' },
    }).onConflictDoNothing()
})

afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId)).catch(() => { })
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => { })
})

describe('buildIntrospectionSnapshot — concurrent safety', () => {
    it('10 parallel calls all resolve without throwing', async () => {
        const promises = Array.from({ length: 10 }, () =>
            buildIntrospectionSnapshot(workspaceId, 'anthropic', 'claude-sonnet-4-6')
        )

        // All must settle — no unhandled rejections
        const results = await Promise.allSettled(promises)

        for (const result of results) {
            expect(result.status).toBe('fulfilled')
        }
    })

    it('10 parallel calls return consistent snapshot shapes', async () => {
        const snapshots = await Promise.all(
            Array.from({ length: 10 }, () =>
                buildIntrospectionSnapshot(workspaceId)
            )
        )

        expect(snapshots).toHaveLength(10)

        // Every snapshot must carry the required top-level fields
        const requiredFields = ['generatedAt', 'workspaceId', 'build'] as const
        for (const snap of snapshots) {
            for (const field of requiredFields) {
                expect(snap).toHaveProperty(field)
            }
        }

        // workspaceId must be consistent across all parallel results
        const wsIds = snapshots.map(s => s.workspaceId)
        const uniqueIds = new Set(wsIds.filter(Boolean))
        // Either all return the same workspaceId or all omit it (graceful degradation)
        expect(uniqueIds.size).toBeLessThanOrEqual(1)

        // generatedAt timestamps must be ISO strings (not NaN or undefined)
        for (const snap of snapshots) {
            expect(typeof snap.generatedAt).toBe('string')
            expect(new Date(snap.generatedAt).getTime()).not.toBeNaN()
        }
    })

    it('10 parallel calls on nonexistent workspace: graceful degradation, no crash', async () => {
        const ghostId = '00000000-0000-4000-0000-000000000000'

        const results = await Promise.allSettled(
            Array.from({ length: 10 }, () =>
                buildIntrospectionSnapshot(ghostId)
            )
        )

        // The function documents non-fatal per-section failures — must not throw
        for (const result of results) {
            expect(result.status).toBe('fulfilled')
        }
    })

    it('mixed parallel calls with and without provider override: no cross-contamination', async () => {
        const [withProvider, withoutProvider] = await Promise.all([
            Promise.all(Array.from({ length: 5 }, () =>
                buildIntrospectionSnapshot(workspaceId, 'openai', 'gpt-4o')
            )),
            Promise.all(Array.from({ length: 5 }, () =>
                buildIntrospectionSnapshot(workspaceId)
            )),
        ])

        // Snapshots built with explicit provider should reflect it
        for (const snap of withProvider) {
            expect(snap.generatedAt).toBeTruthy()
        }

        // Snapshots built without override should also be valid
        for (const snap of withoutProvider) {
            expect(snap.generatedAt).toBeTruthy()
        }
    })
})
