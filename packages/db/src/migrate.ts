// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import 'dotenv/config'
import path from 'node:path'
import { readdirSync, readFileSync } from 'fs'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

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
            // Also validate that journal entries are ordered consistently by `idx`
            // and `when` — Drizzle's migrator sorts by `when` (epoch ms), so a new
            // entry hand-edited with a `when` smaller than an existing later entry
            // would be silently skipped. Fail loud here instead.
            const journalPath = path.join(absoluteMigrationsPath, 'meta', '_journal.json')
            let expectedCount = 0
            try {
                const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as { entries?: Array<{ idx: number; when: number; tag: string }> }
                const entries = Array.isArray(journal.entries) ? journal.entries : []
                expectedCount = entries.length
                for (let i = 1; i < entries.length; i++) {
                    const prev = entries[i - 1]!
                    const curr = entries[i]!
                    if (curr.idx <= prev.idx) {
                        console.error(`[migrate] JOURNAL ERROR: idx out of order at ${curr.tag} (idx=${curr.idx}, prev idx=${prev.idx}). Aborting.`)
                        process.exit(1)
                    }
                    if (curr.when <= prev.when) {
                        console.error(`[migrate] JOURNAL ERROR: \`when\` out of order at ${curr.tag} (when=${curr.when}, prev when=${prev.when}). Drizzle sorts by \`when\` and would silently skip this. Bump \`when\` past ${prev.when}.`)
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

            // The migrate() call is the one that actually establishes the connection
            await migrate(db, { migrationsFolder })

            const elapsed = ((Date.now() - start) / 1000).toFixed(1)
            console.log(`[migrate] Complete in ${elapsed}s`)

            // Verify Drizzle's tracking table reflects the full journal. A partial
            // run that exits 0 leaves the API booting into 500s on first query.
            const rows = await sql<{ count: number }[]>`
                SELECT COUNT(*)::int AS count FROM drizzle.__drizzle_migrations
            `
            const appliedCount = rows[0]?.count ?? 0
            console.log(`[migrate] applied ${appliedCount} of ${expectedCount}`, { appliedCount, expectedCount })

            await sql.end()
            clearTimeout(timer)

            if (appliedCount < expectedCount) {
                console.error(
                    `[migrate] PARTIAL RUN: applied ${appliedCount} of ${expectedCount} migrations. ` +
                    `Failing loud so the migrate service exits non-zero.`
                )
                process.exit(1)
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

