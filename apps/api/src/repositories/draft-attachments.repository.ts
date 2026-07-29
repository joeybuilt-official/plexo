// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Draft-attachments data-access repository.
 *
 * owns the conversation attachment append + scan-queue enqueue
 * the draft-attachment upload performs. Multipart parsing, storage, and hashing
 * stay in the route.
 */
import { eq, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { conversations, attachmentScanQueue } from '@plexo/db'

type NewScanQueueRow = typeof attachmentScanQueue.$inferInsert

/** Conversation id + workspace + current attachments (for the workspace check). */
export async function getConversationForAttachment(conversationId: string): Promise<{ id: string; workspaceId: string; attachments: unknown } | undefined> {
    const [conv] = await db
        .select({ id: conversations.id, workspaceId: conversations.workspaceId, attachments: conversations.attachments })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
    return conv
}

/** Append an attachment record to a conversation's attachments jsonb array. */
export async function appendAttachment(conversationId: string, attachment: unknown): Promise<void> {
    await db
        .update(conversations)
        .set({
            attachments: sql`COALESCE(${conversations.attachments}, '[]'::jsonb) || ${JSON.stringify([attachment])}::jsonb`,
        })
        .where(eq(conversations.id, conversationId))
}

/** Enqueue a clamd scan (deduped by content_hash). */
export async function enqueueScan(values: NewScanQueueRow): Promise<void> {
    await db.insert(attachmentScanQueue).values(values).onConflictDoNothing({ target: attachmentScanQueue.contentHash })
}
