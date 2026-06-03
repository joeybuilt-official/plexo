// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import 'dotenv/config'
import path from 'node:path'
import os from 'node:os'
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

interface JournalEntry { idx: number; when: number; tag: string }

/**
 * Apply migrations with a COMMIT BOUNDARY after the last enum-extending
 * migration, instead of drizzle's default single-transaction-for-the-whole-batch.
 *
 * Why: Postgres forbids using a newly ALTER TYPE … ADD VALUE'd enum value in the
 * same transaction that added it (error 55P04). The schema already splits the
 * add (0116_gmessages_phase2) from the use (0117_…_schema seed) into separate
 * migration files — which works on incremental prod deploys (separate runs) but
 * NOT on a fresh DB, where drizzle batches every pending migration into one
 * transaction and the add+use collide.
 *
 * Fix: run drizzle's migrator in two passes. Pass 1 targets a temp folder whose
 * journal stops at the last enum-add migration, so those ADD VALUEs commit. Pass
 * 2 runs the full folder; drizzle's MAX(created_at) skip-threshold means it only
 * applies what pass 1 left, now in a fresh transaction where the values are
 * already committed. On a DB that has already applied through the boundary
 * (prod, incremental) pass 1 is a no-op, so re-apply behaviour for later
 * migrations is unchanged from drizzle's default.
 */
async function migrateWithEnumCommitBoundary(
    db: PostgresJsDatabase<Record<string, never>>,
    migrationsFolder: string,
): Promise<void> {
    // Resolve to absolute so temp-folder symlinks (below) point at real files
    // regardless of cwd — a relative symlink target resolves against the link's
    // own directory (the temp dir), not the process cwd.
    const absFolder = path.resolve(migrationsFolder)
    const journalPath = path.join(absFolder, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as { entries: JournalEntry[] }
    const entries = journal.entries

    let lastEnumAddIdx = -1
    for (let i = 0; i < entries.length; i++) {
        const sqlText = readFileSync(path.join(absFolder, `${entries[i]!.tag}.sql`), 'utf-8')
        if (/ALTER\s+TYPE[\s\S]*?ADD\s+VALUE/i.test(sqlText)) lastEnumAddIdx = i
    }

    // Only need a boundary when there are migrations AFTER the last enum-add.
    if (lastEnumAddIdx >= 0 && lastEnumAddIdx < entries.length - 1) {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'plexo-migrate-'))
        mkdirSync(path.join(tmp, 'meta'), { recursive: true })
        const subset = { ...journal, entries: entries.slice(0, lastEnumAddIdx + 1) }
        writeFileSync(path.join(tmp, 'meta', '_journal.json'), JSON.stringify(subset))
        for (const e of subset.entries) {
            symlinkSync(path.join(absFolder, `${e.tag}.sql`), path.join(tmp, `${e.tag}.sql`))
        }
        console.log(`[migrate] phase 1/2 — committing through enum-add boundary ${entries[lastEnumAddIdx]!.tag}`)
        await migrate(db, { migrationsFolder: tmp })
    }

    console.log(`[migrate] applying full migration set`)
    await migrate(db, { migrationsFolder })
}

// Hard timeout: exit 1 if migrations don't complete within this window.
// Prevents indefinite hangs on locked DB, wrong credentials, or corrupt state.
const TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

const timer = setTimeout(() => {
    console.error(
        `[migrate] TIMEOUT: migrations did not complete within ${TIMEOUT_MS / 60_000} minutes. ` +
        'Check that Postgres is healthy and DATABASE_URL is correct. Exiting.'
    )
    process.exit(1)
}, TIMEOUT_MS)
// Don't let the timer itself keep the event loop alive if everything finishes early.
timer.unref()

const MAX_RETRIES = 30
const RETRY_DELAY_MS = 2000

async function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function runMigrations() {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
        console.error('[migrate] ERROR: DATABASE_URL environment variable is required')
        process.exit(1)
    }

    const migrationsFolder = process.env.MIGRATIONS_DIR ?? './drizzle'
    const absoluteMigrationsPath = path.resolve(process.cwd(), migrationsFolder)


    console.log(`[migrate] --- DIAGNOSTICS ---`)
    console.log(`[migrate] CWD: ${process.cwd()}`)
    console.log(`[migrate] MIGRATIONS_DIR (env): ${process.env.MIGRATIONS_DIR ?? 'not set'}`)
    console.log(`[migrate] Resolved Path: ${absoluteMigrationsPath}`)
    
    let fileCount = 0
    let files: string[] = []
    try {
        files = readdirSync(migrationsFolder).filter(f => f.endsWith('.sql'))
        fileCount = files.length
        console.log(`[migrate] Files found: ${fileCount}`)
        if (fileCount > 0) {
            console.log(`[migrate] Sample: ${files.slice(0, 3).join(', ')}...`)
        }
    } catch (err: any) {
        console.error(`[migrate] ERROR: Could not read migrations folder: ${migrationsFolder}`)
        console.error(`[migrate] Reason: ${err.message}`)
        process.exit(1)
    }

    try {
        const url = new URL(connectionString)
        console.log(`[migrate] URL Check: Valid format. Protocol: ${url.protocol}, Host: ${url.host}, DB: ${url.pathname}`)
    } catch {
        console.error(`[migrate] ERROR: Invalid DATABASE_URL format. Check for special characters in password.`)
        process.exit(1)
    }

    // ── Namespace guard ──────────────────────────────────────────────────────
    // When APP_SCHEMA_NAMESPACE is set, verify every migration file only
    // targets that schema. This prevents apps from running DDL outside their
    // declared namespace. Core's own migrations run without a namespace.
    const namespace = process.env.APP_SCHEMA_NAMESPACE
    if (namespace) {
        console.log(`[migrate] Namespace guard active: ${namespace}`)
        const NAMESPACE_RE = /^[a-z][a-z0-9_]*$/
        if (!NAMESPACE_RE.test(namespace)) {
            console.error(`[migrate] ERROR: APP_SCHEMA_NAMESPACE "${namespace}" is invalid. Must match /^[a-z][a-z0-9_]*$/`)
            process.exit(1)
        }

        // Scan each migration file for schema references outside the namespace.
        // We look for SET search_path or explicit schema.table references.
        const schemaRefRe = /(?:SET\s+search_path\s*(?:TO|=)\s*(\w+))|(?:(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TYPE|SEQUENCE|VIEW)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\w+)\.)/gi
        for (const file of files) {
            const content = readFileSync(path.join(migrationsFolder, file), 'utf-8')
            let match: RegExpExecArray | null
            while ((match = schemaRefRe.exec(content)) !== null) {
                const referenced = (match[1] || match[2])?.toLowerCase()
                if (referenced && referenced !== namespace && referenced !== 'public') {
                    console.error(`[migrate] Migration ${file} references schema "${referenced}" but namespace is "${namespace}". Aborting.`)
                    process.exit(1)
                }
            }
        }
        console.log(`[migrate] Namespace guard passed: all ${files.length} files target "${namespace}" or public`)
    }

    console.log(`[migrate] Starting migrations...`)

    let lastError: any = null
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (attempt > 1) {
                console.log(`[migrate] Retry attempt ${attempt}/${MAX_RETRIES}...`)
            } else {
                console.log(`[migrate] Connecting to Postgres...`)
            }

            const sql = postgres(connectionString, {
                max: 1,
                connect_timeout: 10, // faster fail for retries
                idle_timeout: 60,
                onnotice: () => { }, // suppress notices
            })

            const db = drizzle(sql)
            const start = Date.now()

            // If a namespace is set, ensure the target PG schema exists
            if (namespace) {
                await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${namespace}`)
                console.log(`[migrate] Ensured schema "${namespace}" exists`)
            }

            // Count expected migrations from the on-disk journal before running.
            // Validate journal invariants. Drizzle iterates journal entries in array
            // order (not sorted by `when`); `when` is persisted as `created_at` in
            // `__drizzle_migrations`, and incremental runs use `MAX(created_at)` as
            // a skip threshold. The invariants we enforce:
            //   1. `idx` is monotonic in array order (so the apply order is stable).
            //   2. The LAST entry's `when` exceeds the max of all priors — so a new
            //      hand-edited migration applies on the next incremental run against
            //      a DB that has already applied through the prior maximum.
            // We deliberately do NOT enforce pairwise `when` monotonicity: the
            // existing journal has historical out-of-order pairs (e.g., idx 36→37,
            // 86→88, 91→92, 101→102) that are benign because Drizzle iterates in
            // array order, not `when` order.
            const journalPath = path.join(absoluteMigrationsPath, 'meta', '_journal.json')
            let expectedCount = 0
            let lastJournalWhen = 0
            try {
                const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as { entries?: Array<{ idx: number; when: number; tag: string }> }
                const entries = Array.isArray(journal.entries) ? journal.entries : []
                expectedCount = entries.length
                lastJournalWhen = entries[entries.length - 1]?.when ?? 0
                for (let i = 1; i < entries.length; i++) {
                    const prev = entries[i - 1]!
                    const curr = entries[i]!
                    if (curr.idx <= prev.idx) {
                        console.error(`[migrate] JOURNAL ERROR: idx out of order at ${curr.tag} (idx=${curr.idx}, prev idx=${prev.idx}). Aborting.`)
                        process.exit(1)
                    }
                }
                if (entries.length >= 2) {
                    const last = entries[entries.length - 1]!
                    const priorMaxWhen = entries.slice(0, -1).reduce((m, e) => Math.max(m, e.when), 0)
                    if (last.when <= priorMaxWhen) {
                        console.error(`[migrate] JOURNAL ERROR: last entry ${last.tag} has when=${last.when} but MAX(prior when)=${priorMaxWhen}. Drizzle uses MAX(created_at) from __drizzle_migrations as the per-DB skip threshold; a new entry's when must exceed all prior. Bump past ${priorMaxWhen}.`)
                        process.exit(1)
                    }
                }

                // Disk-vs-journal: warn loud when SQL files exist on disk that the
                // journal doesn't reference. Drizzle's migrator skips them silently,
                // so they NEVER apply to any DB. Phase A audit flagged 0095-0098
                // (synthesis_alpha, themes_*, joeybuilt_apps_auto_connect) as
                // existing on disk but not journaled. We warn (not fail) because
                // the operator may have intentionally orphaned an in-flight
                // migration; failing here would block every subsequent migrate.
                const journaledTags = new Set(entries.map((e) => e.tag))
                const orphaned = files
                    .map((f) => f.replace(/\.sql$/, ''))
                    .filter((tag) => !journaledTags.has(tag))
                if (orphaned.length > 0) {
                    console.warn(`[migrate] WARNING: ${orphaned.length} SQL file(s) on disk are NOT in _journal.json — Drizzle will skip these silently:`)
                    for (const tag of orphaned) console.warn(`  - ${tag}.sql`)
                    console.warn('[migrate] If these are real migrations, generate via drizzle-kit so they get journaled. If they were intentionally orphaned (in-flight), ignore this warning.')
                }
            } catch (err: any) {
                console.error(`[migrate] ERROR: could not read journal at ${journalPath}: ${err.message}`)
                process.exit(1)
            }

            // The migrate() call is the one that actually establishes the connection.
            // Two-pass (enum commit boundary) so fresh DBs don't hit Postgres 55P04
            // on the 0116 ADD VALUE / 0117 use split; no-op extra pass on prod.
            await migrateWithEnumCommitBoundary(db, migrationsFolder)

            const elapsed = ((Date.now() - start) / 1000).toFixed(1)
            console.log(`[migrate] Complete in ${elapsed}s`)

            // Verify the latest journal migration is tracked. Drizzle uses
            // MAX(created_at) as the skip threshold — if MAX matches the last
            // journal `when`, all current migrations are applied. Row count can
            // be < journal length when older migrations were applied outside
            // drizzle (manual psql), which is safe if the schema is correct.
            const maxRows = await sql<{ max_when: string | null }[]>`
                SELECT MAX(created_at)::text AS max_when FROM drizzle.__drizzle_migrations
            `
            const countRows = await sql<{ count: number }[]>`
                SELECT COUNT(*)::int AS count FROM drizzle.__drizzle_migrations
            `
            const appliedMaxWhen = Number(maxRows[0]?.max_when ?? 0)
            const appliedCount = countRows[0]?.count ?? 0
            console.log(`[migrate] applied ${appliedCount} of ${expectedCount} (max_when=${appliedMaxWhen}, last_journal_when=${lastJournalWhen})`, { appliedCount, expectedCount })

            await sql.end()
            clearTimeout(timer)

            if (appliedMaxWhen < lastJournalWhen) {
                console.error(
                    `[migrate] PARTIAL RUN: latest migration not applied (max_when=${appliedMaxWhen} < last_journal_when=${lastJournalWhen}). ` +
                    `Failing loud so the migrate service exits non-zero.`
                )
                process.exit(1)
            }
            if (appliedCount < expectedCount) {
                console.warn(
                    `[migrate] TRACKING GAP: ${appliedCount} of ${expectedCount} rows in __drizzle_migrations — ` +
                    `${expectedCount - appliedCount} older migrations were applied outside drizzle. Schema should be correct.`
                )
            }

            process.exit(0)
        } catch (err: any) {
            lastError = err
            const msg = err instanceof Error ? err.message : String(err)
            const code = err?.code

            // Connection refused / DB starting up
            if (code === 'ECONNREFUSED' || msg.includes('connection refused') || msg.includes('starting up')) {
                console.warn(`[migrate] Database is not ready yet. Waiting ${RETRY_DELAY_MS}ms...`)
            }
            // Password authentication failed (28P01)
            else if (code === '28P01' || msg.includes('password authentication failed')) {
                console.warn(`[migrate] Authentication failed. This might be transient during first boot. Waiting ${RETRY_DELAY_MS}ms...`)

                if (attempt > 10) {
                    console.error('[migrate] BOTTLENECK IDENTIFIED: Authentication is consistently failing.')
                    console.error('[migrate] TROUBLESHOOTING:')
                    console.error('  1. Check if you changed POSTGRES_PASSWORD in .env while an existing pgdata volume exists.')
                    console.error('  2. If so, your DB still uses the OLD password. Use the old one or delete the volume (DANGEROUS).')
                    console.error('  3. Verify DATABASE_URL format in docker-compose.yml matches your password.')
                }
            }
            // Database does not exist yet (3D000)
            else if (code === '3D000') {
                console.warn(`[migrate] Database does not exist yet (still initializing?). Waiting ${RETRY_DELAY_MS}ms...`)
            }
            // Relation/type/index does not exist (42P01, 42704) — migration SQL bug, don't retry
            else if (code === '42P01' || code === '42704') {
                console.error('[migrate] MIGRATION ERROR:', msg)
                if (err.stack) console.error(err.stack)
                process.exit(1)
            }
            else {
                // Unexpected error or migration conflict
                console.error('[migrate] FAILURE ERROR:', msg)
                if (err.stack) console.error(err.stack)
                console.warn(`[migrate] Retrying in ${RETRY_DELAY_MS}ms...`)
            }

            await wait(RETRY_DELAY_MS)
        }
    }

    console.error(`[migrate] FAILED: Could not complete migrations after ${MAX_RETRIES} attempts.`)
    console.error('[migrate] LAST ERROR:', lastError?.message || lastError)
    process.exit(1)
}

runMigrations()

