// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channels data-access repository.
 *
 * owns the channels table reads/writes. The route keeps
 * config encryption/decryption, webhook auth, and dispatch orchestration.
 */
import { eq, and, desc, inArray, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { channels, conversations, installedConnections, pairedSessions } from '@plexo/db'

/** Full channel row by id, or undefined. */
export async function getById(channelId: string) {
    const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
    return row
}

/** {id,config,workspaceId,enabled} rows for all channels of a given type. */
export async function listByType(type: string) {
    return db
        .select({ id: channels.id, config: channels.config, workspaceId: channels.workspaceId, enabled: channels.enabled })
        .from(channels)
        .where(eq(channels.type, type))
}

/** Descriptor rows for the subscription contract, optionally workspace-scoped. */
export async function listDescriptors(workspaceId?: string) {
    const where = workspaceId ? eq(channels.workspaceId, workspaceId) : undefined
    return db
        .select({
            id: channels.id,
            workspaceId: channels.workspaceId,
            type: channels.type,
            name: channels.name,
            enabled: channels.enabled,
            lastMessageAt: channels.lastMessageAt,
        })
        .from(channels)
        .where(where)
}

/** True when a channel with this id exists. */
export async function existsById(channelId: string): Promise<boolean> {
    const [row] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).limit(1)
    return !!row
}

/** {id,type,config,enabled} for a channel scoped to a workspace (IDOR guard). */
export async function getEnabledScoped(channelId: string, workspaceId: string): Promise<{ id: string; type: string; config: unknown; enabled: boolean } | undefined> {
    const [row] = await db
        .select({ id: channels.id, type: channels.type, config: channels.config, enabled: channels.enabled })
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
        .limit(1)
    return row
}

/** Latest paired_sessions {channelId,state,stateChangedAt} for a workspace. */
export async function getPairedSessionsForWorkspace(workspaceId: string) {
    return db
        .select({
            channelId: pairedSessions.channelId,
            state: pairedSessions.state,
            stateChangedAt: pairedSessions.stateChangedAt,
        })
        .from(pairedSessions)
        .where(eq(pairedSessions.workspaceId, workspaceId))
}

/** Full channel rows for a workspace (capped at 200). */
export async function listByWorkspace(workspaceId: string) {
    return db.select().from(channels).where(eq(channels.workspaceId, workspaceId)).limit(200)
}

/** Full channel row scoped to a workspace (IDOR guard), or undefined. */
export async function getScopedFull(channelId: string, workspaceId: string) {
    const [row] = await db.select()
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
        .limit(1)
    return row
}

/** {id,type} for a channel scoped to a workspace (IDOR guard), or undefined. */
export async function getTypeScoped(channelId: string, workspaceId: string) {
    const [row] = await db.select({ id: channels.id, type: channels.type })
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
        .limit(1)
    return row
}

/** Thread conversations for a channel (source-filtered, channelRef-narrowed). */
export async function listThreadConversations(workspaceId: string, sourceFilter: string, channelId: string) {
    return db
        .select({
            sessionId: conversations.sessionId,
            message: conversations.message,
            reply: conversations.reply,
            createdAt: conversations.createdAt,
            channelRef: conversations.channelRef,
        })
        .from(conversations)
        .where(sql`
            ${conversations.workspaceId} = ${workspaceId}
            AND ${conversations.source} = ${sourceFilter}
            AND ${conversations.sessionId} IS NOT NULL
            AND ${conversations.channelRef}->>'channelId' = ${channelId}
        `)
        .orderBy(desc(conversations.createdAt))
        .limit(2000)
}

/** Messages for a single thread (source + sessionId scoped). */
export async function listThreadMessages(workspaceId: string, sourceFilter: string, sessionId: string) {
    return db.select({
        id: conversations.id,
        message: conversations.message,
        reply: conversations.reply,
        createdAt: conversations.createdAt,
        attachments: conversations.attachments,
    })
        .from(conversations)
        .where(and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.source, sourceFilter),
            eq(conversations.sessionId, sessionId),
        ))
        .orderBy(desc(conversations.createdAt))
        .limit(200)
}

/** Most-recent live paired session {id,state,stateChangedAt} for a channel. */
export async function getLiveSession(channelId: string, workspaceId: string) {
    const [session] = await db.select({
        id: pairedSessions.id,
        state: pairedSessions.state,
        stateChangedAt: pairedSessions.stateChangedAt,
    })
        .from(pairedSessions)
        .where(and(
            eq(pairedSessions.channelId, channelId),
            eq(pairedSessions.workspaceId, workspaceId),
            inArray(pairedSessions.state, ['active', 'paired', 'refreshing']),
        ))
        .orderBy(desc(pairedSessions.stateChangedAt))
        .limit(1)
    return session
}

/** Insert an outbound conversation row (optimistic-send persistence). */
export async function insertOutboundConversation(values: typeof conversations.$inferInsert): Promise<void> {
    await db.insert(conversations).values(values)
}

/** {id} for a workspace's gmail installed_connection, or undefined. */
export async function getGmailConnection(installedConnectionId: string, workspaceId: string) {
    const [conn] = await db.select({ id: installedConnections.id })
        .from(installedConnections)
        .where(and(
            eq(installedConnections.id, installedConnectionId),
            eq(installedConnections.workspaceId, workspaceId),
            eq(installedConnections.registryId, 'gmail'),
        ))
        .limit(1)
    return conn
}

/** Insert a channel row, returning the created row. */
export async function insertChannel(values: typeof channels.$inferInsert) {
    const [created] = await db.insert(channels).values(values).returning()
    return created
}

/** Set a channel's config by id (gmail baseline). */
export async function updateChannelConfig(channelId: string, config: typeof channels.$inferInsert['config']): Promise<void> {
    await db.update(channels)
        .set({ config })
        .where(eq(channels.id, channelId))
}

/** Apply a partial update to a channel scoped to a workspace (IDOR guard). */
export async function updateScoped(channelId: string, workspaceId: string, update: Partial<typeof channels.$inferInsert>): Promise<void> {
    await db.update(channels)
        .set(update)
        .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
}

/** Delete a channel scoped to a workspace (IDOR guard). */
export async function deleteScoped(channelId: string, workspaceId: string): Promise<void> {
    await db.delete(channels)
        .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
}
