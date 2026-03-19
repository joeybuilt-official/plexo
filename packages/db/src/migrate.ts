// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import 'dotenv/config'
import path from 'node:path'
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

            // The migrate() call is the one that actually establishes the connection
            await migrate(db, { migrationsFolder })

            const elapsed = ((Date.now() - start) / 1000).toFixed(1)
            console.log(`[migrate] Complete in ${elapsed}s`)

            await sql.end()
            clearTimeout(timer)
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
            else if (code === '3D000' || msg.includes('does not exist')) {
                console.warn(`[migrate] Database does not exist yet (still initializing?). Waiting ${RETRY_DELAY_MS}ms...`)
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

