// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Training-data export data-access repository (read-only).
 *
 * owns the raw execute() calls behind the training-data
 * endpoints. The SQL strings come from the route's compile-time DATA_SOURCES
 * table; the route keeps the super-admin auth, the semicolon safety guard, and
 * the chat-format conversion. No user data flows into these queries.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

/** Run a source's count SQL (compile-time constant). */
export async function countRows(countSql: string): Promise<Array<{ count: string }>> {
    return db.execute<{ count: string }>(sql.raw(countSql))
}

/** Min/max created_at for a source table. */
export async function getDateRange(table: string): Promise<Array<{ min_date: string | null; max_date: string | null }>> {
    return db.execute<{ min_date: string | null; max_date: string | null }>(
        sql`SELECT MIN(created_at) AS min_date, MAX(created_at) AS max_date FROM ${sql.identifier(table)}`,
    )
}

/** Sample/export rows from a guarded base query with a row cap. */
export async function sampleRows(baseQuery: string, limit: number) {
    return db.execute(sql`${sql.raw(baseQuery)} LIMIT ${limit}`)
}
