// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Conversations data-access repository (postgres path).
 *
 * owns the postgres reads for the conversations table. The
 * route keeps the FalkorDB/cypher feature-flag path, workspace-access checks, and
 * the snake_case→camelCase shaping; only the SQL lives here. All filters stay
 * parameterised (drizzle `sql` template).
 */
import { db, eq, asc, desc, sql } from '@plexo/db'
import { conversations } from '@plexo/db'

type Conversation = typeof conversations.$inferSelect

/** Workspace id for a conversation (cheap scoping lookup), or undefined. */
export async function getConversationWorkspaceId(id: string): Promise<{ workspaceId: string } | undefined> {
    const [auth] = await db
        .select({ workspaceId: conversations.workspaceId })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1)
    return auth
}

/** Full conversation row by id, or undefined. */
export async function getConversationById(id: string): Promise<Conversation | undefined> {
    const [item] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1)
    return item
}

/** All turns for a session, chronological. */
export async function listSessionTurns(workspaceId: string, sessionId: string, limit: number): Promise<Conversation[]> {
    return db
        .select()
        .from(conversations)
        .where(sql`workspace_id = ${workspaceId} AND session_id = ${sessionId}`)
        .orderBy(asc(conversations.createdAt))
        .limit(limit)
}

/**
 * One row per session (latest turn) + turn_count, newest first, cursor-paged.
 * Returns raw snake_case rows (window-function query); caller maps to camelCase.
 */
export async function listGroupedBySession(workspaceId: string, cursor: string | undefined, limit: number): Promise<Array<Record<string, unknown>>> {
    const rows = await db.execute(sql`
        WITH bounded AS (
            SELECT * FROM conversations
            WHERE workspace_id = ${workspaceId}
            ${cursor ? sql`AND created_at < (SELECT created_at FROM conversations WHERE id = ${cursor})` : sql``}
            ORDER BY created_at DESC, id DESC
            LIMIT 500
        ),
        ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (PARTITION BY COALESCE(session_id, id) ORDER BY created_at DESC, id DESC) AS rn,
                   COUNT(*) OVER (PARTITION BY COALESCE(session_id, id)) AS turn_count
            FROM bounded
        )
        SELECT * FROM ranked WHERE rn = 1
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
    `)
    return rows as Array<Record<string, unknown>>
}

/** Flat conversation list for a workspace, newest first, optional id cursor. */
export async function listFlat(workspaceId: string, cursor: string | undefined, limit: number): Promise<Conversation[]> {
    return cursor
        ? db.select().from(conversations)
            .where(sql`workspace_id = ${workspaceId} AND id < ${cursor}`)
            .orderBy(desc(conversations.createdAt))
            .limit(limit)
        : db.select().from(conversations)
            .where(sql`workspace_id = ${workspaceId}`)
            .orderBy(desc(conversations.createdAt))
            .limit(limit)
}
