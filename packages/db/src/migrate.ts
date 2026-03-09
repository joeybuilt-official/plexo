// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import 'dotenv/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

async function runMigrations() {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
        console.error('DATABASE_URL environment variable is required')
        process.exit(1)
    }

    const sql = postgres(connectionString, { max: 1 })
    const db = drizzle(sql)

    console.log('Running migrations...')
    await migrate(db, { migrationsFolder: './drizzle' })
    console.log('Migrations complete.')

    await sql.end()
    process.exit(0)
}

runMigrations().catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
})
