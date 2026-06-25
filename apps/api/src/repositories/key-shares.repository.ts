// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace key-shares data-access repository (cross-workspace credential pointers).
 *
 * owns workspace_key_shares persistence plus the workspace
 * reads/writes the share flows touch. The aiProviders settings-blob manipulation
 * (deciding what a "borrowed" provider entry looks like) stays in the route as
 * business logic; this module only loads/saves the settings JSON.
 */
import { eq, and, inArray } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaceKeyShares, workspaces } from '@plexo/db'

type KeyShare = typeof workspaceKeyShares.$inferSelect
type WorkspaceSettings = typeof workspaces.$inferSelect['settings']

export interface LendingRow {
    id: string
    providerKey: string
    grantedAt: Date
    targetWsId: string
}
export interface BorrowingRow {
    id: string
    providerKey: string
    grantedAt: Date
    sourceWsId: string
}

/** Shares where this workspace is the source (lending out). */
export async function listLending(workspaceId: string): Promise<LendingRow[]> {
    return db
        .select({
            id: workspaceKeyShares.id,
            providerKey: workspaceKeyShares.providerKey,
            grantedAt: workspaceKeyShares.grantedAt,
            targetWsId: workspaceKeyShares.targetWsId,
        })
        .from(workspaceKeyShares)
        .where(eq(workspaceKeyShares.sourceWsId, workspaceId)) as Promise<LendingRow[]>
}

/** Shares where this workspace is the target (borrowing in). */
export async function listBorrowing(workspaceId: string): Promise<BorrowingRow[]> {
    return db
        .select({
            id: workspaceKeyShares.id,
            providerKey: workspaceKeyShares.providerKey,
            grantedAt: workspaceKeyShares.grantedAt,
            sourceWsId: workspaceKeyShares.sourceWsId,
        })
        .from(workspaceKeyShares)
        .where(eq(workspaceKeyShares.targetWsId, workspaceId)) as Promise<BorrowingRow[]>
}

/** id→name map for a set of workspaces (was a full-table scan + JS filter). */
export async function getWorkspaceNamesByIds(ids: string[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {}
    const rows = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(inArray(workspaces.id, ids))
    return Object.fromEntries(rows.map(r => [r.id, r.name]))
}

/** Minimal workspace identity + owner (for grant authz). */
export async function getWorkspaceOwner(workspaceId: string): Promise<{ id: string; ownerId: string } | undefined> {
    const [ws] = await db.select({ id: workspaces.id, ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return ws as { id: string; ownerId: string } | undefined
}

/** Workspace identity + name + owner (target workspace for a grant). */
export async function getWorkspaceForShare(workspaceId: string): Promise<{ id: string; name: string; ownerId: string } | undefined> {
    const [ws] = await db.select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return ws as { id: string; name: string; ownerId: string } | undefined
}

/** Settings JSON for a workspace. */
export async function getWorkspaceSettings(workspaceId: string): Promise<{ settings: WorkspaceSettings } | undefined> {
    const [row] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return row
}

/** Settings JSON + name for a workspace. */
export async function getWorkspaceSettingsAndName(workspaceId: string): Promise<{ settings: WorkspaceSettings; name: string } | undefined> {
    const [row] = await db.select({ settings: workspaces.settings, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return row
}

/** Overwrite a workspace's settings JSON. */
export async function updateWorkspaceSettings(workspaceId: string, settings: WorkspaceSettings): Promise<void> {
    await db.update(workspaces).set({ settings }).where(eq(workspaces.id, workspaceId))
}

export interface InsertKeyShareInput {
    id: string
    sourceWsId: string
    targetWsId: string
    providerKey: string
    grantedBy: string
}

/** Create a key-share pointer (idempotent — ignores duplicates). */
export async function insertKeyShareIgnore(input: InsertKeyShareInput): Promise<void> {
    await db.insert(workspaceKeyShares).values(input).onConflictDoNothing()
}

/** Load a share scoped to its source workspace (object-level authz). */
export async function getShareScoped(shareId: string, sourceWsId: string): Promise<KeyShare | undefined> {
    const [share] = await db
        .select()
        .from(workspaceKeyShares)
        .where(and(eq(workspaceKeyShares.id, shareId), eq(workspaceKeyShares.sourceWsId, sourceWsId)))
        .limit(1)
    return share
}

/** Delete a share by id. */
export async function deleteShare(shareId: string): Promise<void> {
    await db.delete(workspaceKeyShares).where(eq(workspaceKeyShares.id, shareId))
}

/** True when a (source → target, providerKey) share still exists. */
export async function shareExists(sourceWsId: string, targetWsId: string, providerKey: string): Promise<boolean> {
    const [row] = await db
        .select({ id: workspaceKeyShares.id })
        .from(workspaceKeyShares)
        .where(and(
            eq(workspaceKeyShares.sourceWsId, sourceWsId),
            eq(workspaceKeyShares.targetWsId, targetWsId),
            eq(workspaceKeyShares.providerKey, providerKey),
        ))
        .limit(1)
    return !!row
}
