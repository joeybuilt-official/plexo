// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Post-stream conversation persistence use-case for the webchat route.
 *
 * Extracted from the streaming branch of `routes/chat.ts` (the three
 * persistence sites around lines 1068–1130: empty-response, stream-error,
 * and post-stream success). Each site had the same create-vs-update branch:
 *
 *   if (conversationId) updateConversationById(conversationId, { …, status })
 *   else                recordConversation({ workspaceId, sessionId, source, message, …, status, … })
 *
 * This module collapses that into one decision: an existing turn (we already
 * have a conversationId from the pre-stream create) is UPDATEd in place; a
 * turn with no conversationId yet is CREATEd. The route passes the parsed
 * turn result + the ids; this module calls the conversation-log repo.
 *
 * No Express/Drizzle imports — `conversation-log.ts` already wraps the DB.
 */

import {
    recordConversation,
    updateConversationById,
    type RecordConversationParams,
} from '../../conversation-log.js'

/**
 * Fields shared by both the create and update paths for a settled turn.
 *
 * - `status: 'complete'` → `reply` set, `errorMsg` null.
 * - `status: 'failed'`   → `errorMsg` set, `reply` null.
 *
 * The route always passes exactly one of `reply` / `errorMsg`; the repo
 * normalizes the other to null on update.
 */
export interface PersistTurnInput {
    /** Existing conversation row id from the pre-stream create, or null to create. */
    conversationId: string | null
    /** Fields for the CREATE path (ignored when conversationId is set). */
    create: Omit<RecordConversationParams, 'reply' | 'errorMsg' | 'status'>
    /** Settled turn status. */
    status: 'complete' | 'failed'
    /** Assistant reply text (status 'complete'). Null/undefined on failure. */
    reply?: string | null
    /** Error message (status 'failed'). Null/undefined on success. */
    errorMsg?: string | null
}

/**
 * Persist a settled streaming turn. Returns the conversationId that was
 * updated or created, so the caller can thread it back through later writes
 * (e.g. linkTaskToConversation).
 *
 * Behavior matches the original inline branch:
 *   - UPDATE: calls `updateConversationById(conversationId, { reply, errorMsg, status })`.
 *     `reply`/`errorMsg` default to null (repo coerces undefined → null on set).
 *   - CREATE: calls `recordConversation({ …create, reply, errorMsg, status })`.
 */
export async function persistTurn(input: PersistTurnInput): Promise<string> {
    const { status, reply = null, errorMsg = null } = input
    if (input.conversationId) {
        await updateConversationById(input.conversationId, {
            reply: reply ?? null,
            errorMsg: errorMsg ?? null,
            status,
        })
        return input.conversationId
    }
    return recordConversation({
        ...input.create,
        reply: reply ?? null,
        errorMsg: errorMsg ?? null,
        status,
    })
}