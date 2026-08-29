// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase A stand-up integration test.
 *
 * Encodes audit exit criterion #1: a fresh `docker compose down -v &&
 * docker compose up -d --build` reaches healthy. Rather than driving
 * docker (Phase G), this test asserts the boot fixes that block a
 * clean stand-up:
 *
 *   #1 postgres listen_addresses=*       — verified by simply being
 *      able to connect from outside the postgres container; if this
 *      test connects to DATABASE_URL it has passed.
 *   #2 Better Auth migration (0099)      — auth.user, auth.session,
 *      auth.account, auth.verification must exist and auth.user.id
 *      must be uuid (post round-trip on the 0099 migration).
 *   #3 migrate runner loud-fail          — packages/db/src/migrate.ts
 *      compares applied vs journal entry count and process.exit(1)s
 *      when applied < expected. Asserted by inspecting the source.
 *   #8 cron schema repairs               — orphan-user cleanup and
 *      data-retention queries must succeed against the live schema
 *      without column-not-found / table-not-found errors.
 *
 * Runs against the dev postgres at DATABASE_URL (same convention as
 * tests/integration/queue.test.ts and tests/setup.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { db } from '@plexo/db'
import { sql } from 'drizzle-orm'

const REPO_ROOT = path.resolve(__dirname, '../..')

beforeAll(async () => {
    const [row] = await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`)
    expect(row?.ok).toBe(1)
})

describe('Phase A stand-up — fix #2: Better Auth schema', () => {
    const tables = ['user', 'session', 'account', 'verification']

    for (const t of tables) {
        it(`auth."${t}" table exists`, async () => {
            const [row] = await db.execute<{ exists: boolean }>(sql`
                SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = 'auth'
                      AND table_name = ${t}
                ) AS exists
            `)
            expect(row?.exists).toBe(true)
        })
    }

    it('auth.user has the columns Better Auth queries on first call', async () => {
        const cols = await db.execute<{ column_name: string }>(sql`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'auth' AND table_name = 'user'
        `)
        const names = new Set(cols.map((c) => c.column_name))
        for (const required of ['id', 'email', 'emailVerified', 'createdAt', 'updatedAt']) {
            expect(names.has(required)).toBe(true)
        }
    })

    it('auth.user.id is uuid (post round-trip on 0099)', async () => {
        const [row] = await db.execute<{ data_type: string; udt_name: string }>(sql`
            SELECT data_type, udt_name
            FROM information_schema.columns
            WHERE table_schema = 'auth'
              AND table_name = 'user'
              AND column_name = 'id'
        `)
        expect(row?.data_type).toBe('uuid')
        expect(row?.udt_name).toBe('uuid')
    })
})

describe('Phase A stand-up — fix #3: migrate runner loud-fail', () => {
    it('migrate.ts exits non-zero when applied < expected journal entries', () => {
        // The runner cannot be exec'd against a DB seeded with a
        // missing migration from inside vitest without a second
        // postgres instance, so this assertion pins the source: the
        // throw site must compare appliedCount < expectedCount and
        // call process.exit(1). If a refactor removes that branch,
        // the api will boot against a partial schema again.
        const src = readFileSync(
            path.join(REPO_ROOT, 'packages/db/src/migrate.ts'),
            'utf8',
        )
        expect(src).toMatch(/appliedCount\s*<\s*expectedCount/)
        expect(src).toMatch(/process\.exit\(1\)/)
        expect(src).toMatch(/PARTIAL RUN/)
    })

    it('0099_better_auth is registered in the journal', () => {
        const journal = JSON.parse(
            readFileSync(
                path.join(REPO_ROOT, 'packages/db/drizzle/meta/_journal.json'),
                'utf8',
            ),
        ) as { entries: Array<{ tag: string }> }
        const tags = journal.entries.map((e) => e.tag)
        expect(tags).toContain('0099_better_auth')
    })
})

describe('Phase A stand-up — fix #8: cron query schema repairs', () => {
    it('orphan-user cleanup SQL joins auth.user.id to workspace_members.user_id (both uuid)', async () => {
        // Mirrors apps/api/src/cron.ts:reconcileOrphanedUsers. Both
        // sides are uuid in the live DB (workspace_members.user_id was
        // promoted to uuid by an earlier migration; schema.ts:769 still
        // declares text — known TS/DDL drift, tracked for follow-up).
        await expect(
            db.execute(sql`
                SELECT 1
                FROM workspace_members wm
                WHERE NOT EXISTS (
                    SELECT 1 FROM auth."user" au WHERE au.id = wm.user_id
                )
                LIMIT 1
            `),
        ).resolves.toBeDefined()
    })

    it('data-retention DELETE queries succeed against session_logs and work_ledger', async () => {
        // runDataRetention is not exported from cron.ts; pin the
        // exact SQL it issues. Use 100000 days so we never delete
        // real rows. Asserts the columns/tables referenced exist.
        await expect(
            db.execute(sql`
                DELETE FROM session_logs
                WHERE created_at < NOW() - INTERVAL '1 day' * ${100000}
            `),
        ).resolves.toBeDefined()

        await expect(
            db.execute(sql`
                DELETE FROM work_ledger
                WHERE completed_at < NOW() - INTERVAL '1 day' * ${100000}
            `),
        ).resolves.toBeDefined()
    })
})
