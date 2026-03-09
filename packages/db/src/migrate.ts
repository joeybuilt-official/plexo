// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import 'dotenv/config'
import { readdirSync } from 'fs'
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

async function runMigrations() {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
        console.error('[migrate] ERROR: DATABASE_URL environment variable is required')
        process.exit(1)
    }

    const migrationsFolder = process.env.MIGRATIONS_DIR ?? './drizzle'

    // Count pending migration files so the user can see progress context.
    let fileCount = 0
    try {
        fileCount = readdirSync(migrationsFolder).filter(f => f.endsWith('.sql')).length
    } catch {
        // Non-fatal — folder check failure will surface during migrate() itself.
    }

    console.log(`[migrate] Starting — ${fileCount} migration file(s) in ${migrationsFolder}`)
    console.log(`[migrate] Connecting to Postgres...`)

    const sql = postgres(connectionString, {
        max: 1,
        connect_timeout: 30, // seconds — fast-fail if DB is unreachable
        idle_timeout: 60,
    })
    const db = drizzle(sql)

    const start = Date.now()
    await migrate(db, { migrationsFolder })
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)

    console.log(`[migrate] Complete in ${elapsed}s`)
    await sql.end()
    clearTimeout(timer)
    process.exit(0)
}

runMigrations().catch((err) => {
    console.error('[migrate] FAILED:', err instanceof Error ? err.message : err)
    process.exit(1)
})
