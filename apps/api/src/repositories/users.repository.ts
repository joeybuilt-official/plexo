// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Users data-access repository (read-only).
 *
 * owns the `users` table reads behind the super-admin Users
 * API (list + by-id). The `users` table is a postgres_fdw foreign table and is
 * read-only by contract, so this repo never writes. The route keeps the
 * super-admin gate, UUID validation, and response shaping. Distinct from
 * user-self.repository.ts, which owns the separate `user_self` table.
 */
import { db, eq, desc } from '@plexo/db'
import { users } from '@plexo/db'

type User = typeof users.$inferSelect

/** Recent users (id/email/name/role/createdAt), newest first, capped at `limit`. */
export function listUsers(limit: number) {
    return db
        .select({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(limit)
}

/** A single user (id/email/name/role/createdAt) by id, or undefined. */
export async function getUserById(id: string): Promise<Pick<User, 'id' | 'email' | 'name' | 'role' | 'createdAt'> | undefined> {
    const [user] = await db
        .select({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, id))
        .limit(1)
    return user
}
