// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { sql } from 'drizzle-orm'
import type { Database } from '../client'

/**
 * Better Auth user payload shape (subset used for the public.users mirror).
 * Matches the object passed to `databaseHooks.user.create.after` and the
 * shape returned by `auth.api.getSession().user`.
 */
export interface AuthUserPayload {
    id: string
    name: string
    email: string
    emailVerified: boolean
    createdAt: Date | string
    updatedAt: Date | string
    image?: string | null
}

/**
 * Drizzle transaction handle. We accept either the top-level `db` or a tx
 * from `db.transaction(...)` — both expose `.execute(sql)`.
 */
type Executor = Pick<Database, 'execute'>

/**
 * Mirror a Better Auth user record into `public.users`.
 *
 * Idempotent: ON CONFLICT (id) DO NOTHING. Safe to call from both the
 * Better Auth `databaseHooks.user.create.after` callback and the workspace
 * POST handler — whichever runs first wins, the other is a no-op.
 *
 * UUID cast rationale (deferred-item 10, fixed in Phase J):
 *   schema.ts declares users.id as `text`, but the live DDL on `public.users`
 *   (FDW-mapped to auth."user") is `uuid`. Without an explicit `::uuid` cast,
 *   PG rejects the INSERT because text→uuid is not an implicit cast.
 *   The cast is forward-compatible: once Phase J reconciles the schema, the
 *   cast remains a no-op.
 */
export async function mirrorAuthUserToPublic(
    user: AuthUserPayload,
    executor: Executor,
): Promise<void> {
    await executor.execute(sql`
        INSERT INTO public.users (
            id, name, email, "emailVerified", image, "createdAt", "updatedAt"
        ) VALUES (
            ${user.id}::uuid,
            ${user.name},
            ${user.email},
            ${user.emailVerified},
            ${user.image ?? null},
            ${user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt},
            ${user.updatedAt instanceof Date ? user.updatedAt.toISOString() : user.updatedAt}
        )
        ON CONFLICT (id) DO NOTHING
    `)
}
