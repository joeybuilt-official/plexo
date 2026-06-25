// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension contexts data-access repository.
 *
 * owns extension_contexts persistence. The route keeps token
 * estimation, TTL/expiry computation, validation, and response shaping; only the
 * SQL lives here. Reads are workspace-scoped + exclude soft-deleted rows.
 */
import { db, eq, and, isNull, sql } from '@plexo/db'
import { extensionContexts } from '@plexo/db'

type ExtensionContext = typeof extensionContexts.$inferSelect
type NewExtensionContext = typeof extensionContexts.$inferInsert

export interface ListContextsOpts {
    workspaceId: string
    enabled?: boolean
    extensionName?: string
    limit: number
    offset: number
}

/** List contexts for a workspace, ordered by priority then extension name. */
export async function listContexts(opts: ListContextsOpts): Promise<ExtensionContext[]> {
    const conditions = [
        eq(extensionContexts.workspaceId, opts.workspaceId),
        isNull(extensionContexts.deletedAt),
    ]
    if (opts.enabled !== undefined) conditions.push(eq(extensionContexts.enabled, opts.enabled))
    if (opts.extensionName) conditions.push(eq(extensionContexts.extensionName, opts.extensionName))

    return db
        .select()
        .from(extensionContexts)
        .where(and(...conditions))
        .orderBy(extensionContexts.priority, extensionContexts.extensionName)
        .limit(opts.limit)
        .offset(opts.offset)
}

/** Count a workspace's contexts for a given extension (for the per-source cap). */
export async function countForExtension(workspaceId: string, extensionName: string): Promise<number> {
    const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(extensionContexts)
        .where(and(
            eq(extensionContexts.workspaceId, workspaceId),
            eq(extensionContexts.extensionName, extensionName),
            isNull(extensionContexts.deletedAt),
        ))
    return Number(countRow?.count ?? 0)
}

/** Insert a context (no-op on conflict); returns the created row or undefined. */
export async function createContext(values: NewExtensionContext): Promise<ExtensionContext | undefined> {
    const [row] = await db.insert(extensionContexts).values(values).onConflictDoNothing().returning()
    return row
}

/** A non-deleted context scoped to its workspace, or undefined. */
export async function getScoped(contextId: string, workspaceId: string): Promise<ExtensionContext | undefined> {
    const [row] = await db
        .select()
        .from(extensionContexts)
        .where(and(
            eq(extensionContexts.id, contextId),
            eq(extensionContexts.workspaceId, workspaceId),
            isNull(extensionContexts.deletedAt),
        ))
        .limit(1)
    return row
}

/** Soft-delete a context by id. */
export async function softDelete(contextId: string): Promise<void> {
    await db
        .update(extensionContexts)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(extensionContexts.id, contextId))
}

/** Apply a partial update to a context by id. */
export async function update(contextId: string, fields: Record<string, unknown>): Promise<void> {
    await db.update(extensionContexts).set(fields).where(eq(extensionContexts.id, contextId))
}

/** All enabled, non-deleted contexts for a workspace (budget calculation). */
export async function listEnabled(workspaceId: string): Promise<ExtensionContext[]> {
    return db
        .select()
        .from(extensionContexts)
        .where(and(
            eq(extensionContexts.workspaceId, workspaceId),
            eq(extensionContexts.enabled, true),
            isNull(extensionContexts.deletedAt),
        ))
}
