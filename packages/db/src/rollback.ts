// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import 'dotenv/config'
import postgres from 'postgres'

async function rollback() {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
        console.error('DATABASE_URL environment variable is required')
        process.exit(1)
    }

    const sql = postgres(connectionString, { max: 1 })

    // Get the last applied migration
    const result = await sql`
    SELECT hash, created_at
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at DESC
    LIMIT 1
  `.catch(() => {
        console.error('No migrations table found. Nothing to roll back.')
        return []
    })

    if (result.length === 0) {
        console.log('No migrations to roll back.')
        await sql.end()
        process.exit(0)
    }

    const lastMigration = result[0]
    console.log(`Rolling back migration: ${lastMigration?.hash}`)

    console.warn('WARNING: This only removes the migration record from the journal.')
    console.warn('WARNING: It does NOT reverse the actual schema changes (no down migrations).')
    console.warn('WARNING: After running this, the schema will be out of sync with the journal.')
    console.warn('WARNING: To fully rollback, restore from a database backup.')

    // Remove the migration record
    await sql`
    DELETE FROM drizzle.__drizzle_migrations
    WHERE hash = ${lastMigration!.hash}
  `

    console.log('Migration record removed. Run the corresponding down migration manually if needed.')
    console.log('Schema state may need manual reconciliation.')

    await sql.end()
    process.exit(0)
}

rollback().catch((err) => {
    console.error('Rollback failed:', err)
    process.exit(1)
})
