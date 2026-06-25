// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Google Messages tools data-access repository.
 *
 * owns the gmessages session lookup plus the conversation
 * reads/writes the thread-list and send tools touch. The route keeps workspace
 * access checks, phone normalization, sidecar dispatch, and response shaping.
 * All queries are workspace-scoped (object-level authz).
 */
import { eq, and, desc, inArray, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { channels, conversations, pairedSessions } from '@plexo/db'

/** gmessages channel ids for a workspace. */
export async function listGmessagesChannelIds(workspaceId: string): Promise<Array<{ id: string }>> {
    return db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.type, 'gmessages')))
}

/** Recent gmessages conversation rows for thread aggregation (capped 2000). */
export async function listGmessagesThreadRows(workspaceId: string, channelIds: string[]) {
    return db
        .select({
            sessionId: conversations.sessionId,
            message: conversations.message,
            reply: conversations.reply,
            createdAt: conversations.createdAt,
            channelRef: conversations.channelRef,
            attachments: conversations.attachments,
        })
        .from(conversations)
        .where(sql`
            ${conversations.workspaceId} = ${workspaceId}
            AND ${conversations.source} = 'gmessages'
            AND ${conversations.sessionId} IS NOT NULL
            AND ${conversations.channelRef}->>'channelId' = ANY(${channelIds})
        `)
        .orderBy(desc(conversations.createdAt))
        .limit(2000)
}

/** Most recently active live gmessages session for a workspace. */
export async function getLiveSession(workspaceId: string): Promise<{ sessionId: string; channelId: string } | undefined> {
    const [row] = await db.select({
        sessionId: pairedSessions.id,
        channelId: pairedSessions.channelId,
    })
        .from(pairedSessions)
        .innerJoin(channels, eq(channels.id, pairedSessions.channelId))
        .where(and(
            eq(pairedSessions.workspaceId, workspaceId),
            eq(channels.type, 'gmessages'),
            inArray(pairedSessions.state, ['active', 'paired', 'refreshing']),
        ))
        .orderBy(desc(pairedSessions.stateChangedAt))
        .limit(1)
    return row
}

/** Recent gmessages conversation channelRefs for phone→thread resolution (capped 500). */
export async function listRecentGmessagesChannelRefs(workspaceId: string): Promise<Array<{ channelRef: unknown }>> {
    return db
        .select({ channelRef: conversations.channelRef })
        .from(conversations)
        .where(and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.source, 'gmessages'),
        ))
        .orderBy(desc(conversations.createdAt))
        .limit(500)
}

/** Insert a sent-message conversation row. */
export async function insertConversation(values: typeof conversations.$inferInsert): Promise<void> {
    await db.insert(conversations).values(values)
}
