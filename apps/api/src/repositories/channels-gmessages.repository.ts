// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Google Messages connector (inbound) data-access repository.
 *
 * owns the sidecar restore-list read, the inbound dedupe +
 * conversation persistence, the lastMessageAt bump, and the paired-session
 * state/heartbeat writes. The route keeps HMAC auth, envelope validation,
 * attachment normalization, and the encrypted-blob handling (decryption stays
 * in the sidecar). Channel existence/type checks use channels.repository.
 */
import { db, channels, conversations, messageDedupe, pairedSessions, installedConnections, eq, inArray, and } from '@plexo/db'

/** Paired sessions to rehydrate on sidecar boot, with encrypted creds. */
export async function listRestoreEntries() {
    return db
        .select({
            pairedSessionId: pairedSessions.id,
            workspaceId: pairedSessions.workspaceId,
            channelId: pairedSessions.channelId,
            credentials: installedConnections.credentials,
        })
        .from(pairedSessions)
        .innerJoin(installedConnections, eq(installedConnections.id, pairedSessions.installedConnectionId))
        .where(and(
            inArray(pairedSessions.state, ['paired', 'active', 'refreshing']),
            eq(installedConnections.registryId, 'gmessages'),
        ))
}

/** Dedupe insert keyed on (workspace_id, gmessages_msg_id). Empty result = duplicate. */
export async function insertDedupe(workspaceId: string, gmessagesMsgId: string, threadId: string): Promise<Array<{ workspaceId: string }>> {
    return db.insert(messageDedupe)
        .values({ workspaceId, gmessagesMsgId, threadId })
        .onConflictDoNothing({ target: [messageDedupe.workspaceId, messageDedupe.gmessagesMsgId] })
        .returning({ workspaceId: messageDedupe.workspaceId })
}

/** Persist an inbound message as a conversation row. */
export async function insertConversation(values: typeof conversations.$inferInsert): Promise<void> {
    await db.insert(conversations).values(values)
}

/** Best-effort lastMessageAt bump for a channel. */
export async function bumpLastMessageAt(channelId: string, at: Date): Promise<void> {
    await db.update(channels).set({ lastMessageAt: at }).where(eq(channels.id, channelId))
}

/** Update a paired session's connection state. */
export async function updateSessionState(pairedSessionId: string, state: string, errorDetail: string | null): Promise<void> {
    await db.update(pairedSessions)
        .set({ state, stateChangedAt: new Date(), errorDetail })
        .where(eq(pairedSessions.id, pairedSessionId))
}

/** Update a paired session's flow heartbeat (last-inbound + decode-error counter). */
export async function updateSessionHeartbeat(pairedSessionId: string, lastInboundAt: Date | undefined, decodeErrorCount: number | undefined): Promise<void> {
    await db.update(pairedSessions)
        .set({ lastInboundAt, decodeErrorCount })
        .where(eq(pairedSessions.id, pairedSessionId))
}
