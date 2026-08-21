// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Conversations data-access repository (postgres path).
 *
 * owns the postgres reads for the conversations table. The
 * route keeps the FalkorDB/cypher feature-flag path, workspace-access checks, and
 * the snake_case→camelCase shaping; only the SQL lives here. All filters stay
 * parameterised (drizzle `sql` template).
 */
import { eq, asc, desc, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
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

/**
 * DD-5: PATCH the per-conversation model + system-prompt overrides by id.
 * `null` clears the field; `undefined` leaves it untouched. Returns the
 * updated row, or undefined if the row does not exist.
 */
export async function updateConversationOverrides(
    id: string,
    update: { modelOverride?: string | null; systemPromptOverride?: string | null },
): Promise<Conversation | undefined> {
    const set: Record<string, string | null> = {}
    if (update.modelOverride !== undefined) set.modelOverride = update.modelOverride
    if (update.systemPromptOverride !== undefined) set.systemPromptOverride = update.systemPromptOverride
    if (Object.keys(set).length === 0) {
        return getConversationById(id)
    }
    const [item] = await db.update(conversations).set(set).where(eq(conversations.id, id)).returning()
    return item
}

/**
 * DD-5: load the most recent conversation row in a session that carries a
 * non-null model or system-prompt override. The chat path inherits these
 * for the next turn (copy-forward) so an override set on any prior turn
 * stays in effect for the whole session.
 */
export async function getLatestSessionOverrides(
    workspaceId: string,
    sessionId: string,
): Promise<{ modelOverride: string | null; systemPromptOverride: string | null } | undefined> {
    const [row] = await db
        .select({
            modelOverride: conversations.modelOverride,
            systemPromptOverride: conversations.systemPromptOverride,
        })
        .from(conversations)
        .where(sql`workspace_id = ${workspaceId} AND session_id = ${sessionId}
            AND (model_override IS NOT NULL OR system_prompt_override IS NOT NULL)`)
        .orderBy(desc(conversations.createdAt))
        .limit(1)
    return row
}

/** All turns for a session, chronological. */
export async function listSessionTurns(workspaceId: string, sessionId: string, limit: number): Promise<Conversation[]> {
    // Webchat client mints `session-<ts>` but the resolver persists turns under
    // `web:session-<ts>:<ulid>`. A strict equality match on the client id finds
    // nothing after a reload, so the transcript looks lost. Match the resolver
    // prefix too so the full thread is recoverable. External channel ids
    // (telegram:/slack:/discord:) keep strict equality.
    const isWebClientId = sessionId.startsWith('session-')
    return db
        .select()
        .from(conversations)
        .where(isWebClientId
            ? sql`workspace_id = ${workspaceId} AND (session_id = ${sessionId} OR session_id LIKE ${'web:' + sessionId + ':%'})`
            : sql`workspace_id = ${workspaceId} AND session_id = ${sessionId}`)
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
