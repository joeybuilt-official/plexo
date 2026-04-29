// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase A stand-up integration test.
 *
 * Encodes audit exit criterion #1: a fresh `docker compose down -v &&
 * docker compose up -d --build` reaches healthy. Rather than driving
 * docker (Phase G), this test asserts the four boot fixes that block
 * a clean stand-up:
 *
 *   #1 postgres listen_addresses=*       — verified by simply being
 *      able to connect from outside the postgres container; if this
 *      test connects to DATABASE_URL it has passed.
 *   #2 Better Auth migration (0099)      — auth.user, auth.session,
 *      auth.account, auth.verification must exist.
 *   #3 migrate runner loud-fail          — every .sql file in the
 *      drizzle folder must have a matching journal entry; if a file
 *      is missing from _journal.json drizzle silently skips it and
 *      the api boots against a partially-applied schema.
 *   #8 cron schema repairs               — orphan-user cleanup and
 *      data-retention queries must succeed against the live schema
 *      without column-not-found / table-not-found errors.
 *
 * Runs against the dev postgres at DATABASE_URL (same convention as
 * tests/integration/queue.test.ts and tests/setup.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { db, sql } from '@plexo/db'
import { reconcileOrphanedUsers } from '../src/cron.js'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const DRIZZLE_DIR = path.join(REPO_ROOT, 'packages/db/drizzle')

// Smoke-check the connection up front so failures in later tests are
// not mistaken for missing tables when the real cause is "no DB".
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
})

describe('Phase A stand-up — fix #3: migrate runner loud-fail', () => {
    it('every .sql file in drizzle/ is registered in _journal.json', () => {
        const files = readdirSync(DRIZZLE_DIR)
            .filter((f) => f.endsWith('.sql'))
            .map((f) => f.replace(/\.sql$/, ''))
            .sort()

        const journal = JSON.parse(
            readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8'),
        ) as { entries: Array<{ tag: string }> }
        const tagged = new Set(journal.entries.map((e) => e.tag))

        const orphaned = files.filter((f) => !tagged.has(f))
        // If this fails, drizzle silently skipped these files and the DB
        // is partially-applied. Phase A fix #3 requires the migrate
        // runner to detect this and exit non-zero rather than booting
        // the api against a broken schema.
        expect(orphaned).toEqual([])
    })

    it('0099_better_auth is registered in the journal', () => {
        const journal = JSON.parse(
            readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8'),
        ) as { entries: Array<{ tag: string }> }
        const tags = journal.entries.map((e) => e.tag)
        expect(tags).toContain('0099_better_auth')
    })
})

describe('Phase A stand-up — fix #8: cron query schema repairs', () => {
    it('orphan-user cleanup (reconcileOrphanedUsers) runs without throwing', async () => {
        // Direct handler import — runs the actual SQL the cron fires.
        // The handler swallows errors today (FUN-040 try/catch); this
        // test pins behaviour: the call resolves to a number, never
        // throws. If the SQL references a column or table that does
        // not exist (e.g. auth.users vs auth."user") this still won't
        // throw at the JS level — so we additionally exercise the
        // underlying query directly below.
        const count = await reconcileOrphanedUsers()
        expect(typeof count).toBe('number')
        expect(count).toBeGreaterThanOrEqual(0)
    })

    it('orphan-user cleanup SQL targets a real auth table (no column-not-found)', async () => {
        // The cron's actual query — re-issued here without the catch
        // wrapper so a schema mismatch surfaces. Use a NOT EXISTS
        // form against an empty workspace_members predicate to keep
        // this side-effect-free.
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
                WHERE created_at < NOW() - INTERVAL '1 day' * ${100000}
            `),
        ).resolves.toBeDefined()
    })
})
