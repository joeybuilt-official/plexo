// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace data-access repository.
 *
 * owns the workspaces table reads/writes. Settings
 * helpers back the per-feature settings routes (search, voice, …); the
 * route keeps encryption, merge logic, and response shaping. All queries
 * are scoped by workspace id.
 */
import { eq, and, desc, inArray, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaces, workspaceMembers, tasks, conversations, memoryEntries, behaviorRules, DEFAULT_INTELLIGENCE_SETTINGS, DEFAULT_WORKSPACE_SETTINGS } from '@plexo/db'
import { mirrorAuthUserToPublic, type AuthUserPayload } from '@plexo/auth'

/** Raw settings JSON for a workspace, or undefined if no such workspace. */
export async function getSettings(workspaceId: string): Promise<Record<string, unknown> | null | undefined> {
    const [ws] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
    return ws?.settings as Record<string, unknown> | null | undefined
}

/** Settings row by id ({settings} or undefined) — preserves workspace-presence distinction. */
export async function getSettingsRow(workspaceId: string): Promise<{ settings: Record<string, unknown> | null } | undefined> {
    const [ws] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
    return ws as { settings: Record<string, unknown> | null } | undefined
}

/** True when a workspace with this id exists. */
export async function exists(workspaceId: string): Promise<boolean> {
    const [ws] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
    return !!ws
}

/** Overwrite a workspace's settings JSON. */
export async function updateSettings(workspaceId: string, settings: Record<string, unknown>): Promise<void> {
    await db.update(workspaces).set({ settings }).where(eq(workspaces.id, workspaceId))
}

/** Workspace ids the given user is a member of. */
export async function listMemberWorkspaceIds(userId: string): Promise<string[]> {
    const rows = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
    return rows.map((m) => m.workspaceId)
}

/**
 * Workspace summaries (id/name/owner/createdAt), newest first, capped 50.
 * Pass ids=null for the super-admin all-workspaces view, or a list to scope
 * to specific workspaces.
 */
export async function listSummaries(ids: string[] | null) {
    const base = db
        .select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId, createdAt: workspaces.createdAt })
        .from(workspaces)
    return ids === null
        ? base.orderBy(desc(workspaces.createdAt)).limit(50)
        : base.where(inArray(workspaces.id, ids)).orderBy(desc(workspaces.createdAt)).limit(50)
}

/** Single workspace row (id/name/owner/settings/createdAt), or undefined. */
export async function getById(id: string) {
    const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId, settings: workspaces.settings, createdAt: workspaces.createdAt })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1)
    return ws
}

/** Narrow {id,name,settings} projection for chat transport. */
export async function getIdNameSettings(id: string) {
    const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name, settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1)
    return ws
}

/**
 * Create a workspace and auto-enroll the owner as a member, in one tx.
 * Optionally backstop-mirrors the owner's auth user (ADR 0001). Returns the
 * created {id,name} or null. The permission-graph shadow-write stays in the
 * route.
 */
export async function createWithOwner(params: { name: string; ownerId: string; ownerMirror: AuthUserPayload | null }) {
    const { name, ownerId, ownerMirror } = params
    return db.transaction(async (tx) => {
        if (ownerMirror) {
            await mirrorAuthUserToPublic(ownerMirror, tx)
        }

        const [ws] = await tx.insert(workspaces)
            .values({
                name,
                ownerId,
                settings: DEFAULT_WORKSPACE_SETTINGS,
                intelligenceSettings: DEFAULT_INTELLIGENCE_SETTINGS,
            })
            .returning({ id: workspaces.id, name: workspaces.name })

        if (!ws) return null

        await tx.insert(workspaceMembers).values({
            workspaceId: ws.id,
            userId: ownerId,
            role: 'owner',
        }).onConflictDoNothing()

        return ws
    })
}

/** Up to `limit` workspace ids (for the last-workspace delete guard). */
export async function listIds(limit: number): Promise<string[]> {
    const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(limit)
    return rows.map((r) => r.id)
}

/** First workspace {id}, or undefined (telegram env-default auto-resolve). */
export async function getFirstId(): Promise<{ id: string } | undefined> {
    const [row] = await db.select({ id: workspaces.id }).from(workspaces).limit(1)
    return row
}

/** Workspace {id} owned by a user, or undefined (agent-dispatch target resolve). */
export async function getIdByOwner(ownerId: string): Promise<{ id: string } | undefined> {
    const [row] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, ownerId)).limit(1)
    return row
}

/** Workspace {id} by id, or undefined (cheap existence check). */
export async function getIdById(id: string): Promise<{ id: string } | undefined> {
    const [row] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id)).limit(1)
    return row
}

/** Ids of running/claimed tasks in a workspace (for executor cancellation). */
export async function listRunningTaskIds(workspaceId: string): Promise<string[]> {
    const rows = await db.select({ id: tasks.id })
        .from(tasks)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, ['running', 'claimed'] as any[])))
        .limit(1000)
    return rows.map((r) => r.id)
}

/** All task ids in a workspace (for S3 asset cleanup before cascade delete). */
export async function listAllTaskIds(workspaceId: string): Promise<string[]> {
    const rows = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workspaceId, workspaceId)).limit(10000)
    return rows.map((r) => r.id)
}

/** Hard-delete a workspace (cascades to all child rows). */
export async function deleteById(id: string): Promise<void> {
    await db.delete(workspaces).where(eq(workspaces.id, id))
}

/** Atomic JSONB-merge update of settings (and optional name). */
export async function patchWithSettingsMerge(id: string, name: string | undefined, settings: Record<string, unknown>): Promise<void> {
    await db.update(workspaces)
        .set({
            ...(name ? { name } : {}),
            settings: sql`COALESCE(settings, '{}'::jsonb) || ${JSON.stringify(settings)}::jsonb`,
        })
        .where(eq(workspaces.id, id))
}

/** Apply a name-only (or other simple) update to a workspace. */
export async function update(id: string, set: Record<string, unknown>): Promise<void> {
    await db.update(workspaces).set(set).where(eq(workspaces.id, id))
}

/** Workspace row for the JSON export (id/name/settings/createdAt), or undefined. */
export async function getForExport(id: string) {
    const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name, settings: workspaces.settings, createdAt: workspaces.createdAt })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1)
    return ws
}

/** All child rows of a workspace for the JSON export. */
export async function loadExportChildren(id: string) {
    return Promise.all([
        db.select().from(conversations).where(eq(conversations.workspaceId, id)).orderBy(desc(conversations.createdAt)).limit(10000),
        db.select().from(tasks).where(eq(tasks.workspaceId, id)).orderBy(desc(tasks.createdAt)).limit(10000),
        db.select().from(memoryEntries).where(eq(memoryEntries.workspaceId, id)).limit(10000),
        db.select().from(behaviorRules).where(eq(behaviorRules.workspaceId, id)).limit(10000),
    ])
}
