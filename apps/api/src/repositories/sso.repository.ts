// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SSO data-access repository (read-only).
 *
 * owns the auth.user email lookup (foreign table via
 * postgres_fdw). The route keeps token verification, consume, and shaping.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

/** Email rows for a user id from the FDW auth.user table. */
export async function getUserEmail(userId: string): Promise<Array<{ email: string }>> {
    return db.execute<{ email: string }>(
        sql`SELECT email FROM auth.user WHERE id = ${userId}::uuid LIMIT 1`,
    )
}
