// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * UserSelf data-access repository (§20).
 *
 * owns the user_self table persistence. The route keeps the
 * request-field selection and default-empty shaping.
 */
import { eq } from 'drizzle-orm'
import { db } from '@plexo/db'
import { userSelf } from '@plexo/db'

type UserSelf = typeof userSelf.$inferSelect

/** UserSelf row for a workspace, or undefined. */
export async function getByWorkspace(workspaceId: string): Promise<UserSelf | undefined> {
    const [row] = await db.select().from(userSelf).where(eq(userSelf.workspaceId, workspaceId))
    return row
}

/** Upsert the provided fields for a workspace's UserSelf; returns the row. */
export async function upsert(workspaceId: string, fields: Record<string, unknown>): Promise<UserSelf | undefined> {
    const [row] = await db
        .insert(userSelf)
        .values({ workspaceId, ...fields })
        .onConflictDoUpdate({ target: userSelf.workspaceId, set: fields })
        .returning()
    return row
}
