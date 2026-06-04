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
 * Idempotent via `WHERE NOT EXISTS` (NOT `ON CONFLICT`). Safe to call from
 * both the Better Auth `databaseHooks.user.create.after` callback and the
 * workspace POST handler — whichever runs first wins, the other is a no-op.
 *
 * Why WHERE NOT EXISTS and not ON CONFLICT (id): on the joeybuilt deployment
 * `public.users` is a postgres_fdw FOREIGN TABLE mapped to auth."user", which
 * has no local unique index — so `ON CONFLICT (id)` raises "no unique or
 * exclusion constraint matching the ON CONFLICT specification" and aborts the
 * enclosing workspace tx (breaking first-workspace creation). WHERE NOT EXISTS
 * needs no constraint and works on both the FDW foreign table and a plain
 * local table (self-host).
 *
 * UUID cast rationale (deferred-item 10):
 *   schema.ts declares users.id as `text`, but the live DDL on `public.users`
 *   (FDW-mapped to auth."user") is `uuid`. Without an explicit `::uuid` cast,
 *   PG rejects the INSERT because text→uuid is not an implicit cast.
 */
export async function mirrorAuthUserToPublic(
    user: AuthUserPayload,
    executor: Executor,
): Promise<void> {
    await executor.execute(sql`
        INSERT INTO public.users (
            id, name, email, "emailVerified", image, "createdAt", "updatedAt"
        )
        SELECT
            ${user.id}::uuid,
            ${user.name},
            ${user.email},
            ${user.emailVerified},
            ${user.image ?? null},
            ${user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt},
            ${user.updatedAt instanceof Date ? user.updatedAt.toISOString() : user.updatedAt}
        WHERE NOT EXISTS (
            SELECT 1 FROM public.users WHERE id = ${user.id}::uuid
        )
    `)
}
