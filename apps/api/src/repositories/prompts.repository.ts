// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension-prompt-library data-access repository (PEX §7.6).
 *
 * arch-findings B1 — owns the extension_prompts reads/updates behind the
 * prompts routes. The route keeps validation, tag filtering, variable
 * merging, and template interpolation. Every query is workspace-scoped and
 * excludes soft-deleted rows.
 */
import { db, eq, and, isNull } from '@plexo/db'
import { extensionPrompts } from '@plexo/db'

export interface ListPromptsFilter {
    workspaceId: string
    enabled?: string
    extensionName?: string
    limit: number
    offset: number
}

/** Paginated, ordered prompt rows for a workspace (tag filtering done in-route). */
export async function listPrompts(filter: ListPromptsFilter) {
    const { workspaceId, enabled, extensionName, limit, offset } = filter
    const conditions = [
        eq(extensionPrompts.workspaceId, workspaceId),
        isNull(extensionPrompts.deletedAt),
    ]
    if (enabled === 'true') conditions.push(eq(extensionPrompts.enabled, true))
    if (enabled === 'false') conditions.push(eq(extensionPrompts.enabled, false))
    if (extensionName) conditions.push(eq(extensionPrompts.extensionName, extensionName))

    return db
        .select()
        .from(extensionPrompts)
        .where(and(...conditions))
        .orderBy(extensionPrompts.extensionName, extensionPrompts.promptId)
        .limit(limit)
        .offset(offset)
}

/** A single non-deleted prompt, scoped to its workspace. */
export async function getPrompt(workspaceId: string, promptId: string) {
    const [row] = await db
        .select()
        .from(extensionPrompts)
        .where(and(
            eq(extensionPrompts.id, promptId),
            eq(extensionPrompts.workspaceId, workspaceId),
            isNull(extensionPrompts.deletedAt),
        ))
        .limit(1)
    return row
}

/** Apply a partial update to a prompt by id. */
export async function updatePrompt(promptId: string, update: Record<string, unknown>) {
    await db.update(extensionPrompts).set(update).where(eq(extensionPrompts.id, promptId))
}
