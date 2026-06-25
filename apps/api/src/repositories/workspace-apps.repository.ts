// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace-apps data-access repository (app authorizations).
 *
 * owns user_app_authorizations persistence plus the workspace
 * + app-profile existence checks and the per-workspace app listing the routes
 * need. Validation and response shaping stay in the route.
 */
import { db, eq, and } from '@plexo/db'
import { appProfiles, userAppAuthorizations, workspaces } from '@plexo/db'

type Authorization = typeof userAppAuthorizations.$inferSelect

export interface WorkspaceApp {
    appId: string
    schemaNamespace: string | null
    displayName: string | null
    lastSeenAt: Date | null
}

/** Whether a workspace exists. */
export async function workspaceExists(workspaceId: string): Promise<boolean> {
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return Boolean(ws)
}

/** Whether an app profile is registered on this node. */
export async function appProfileExists(appId: string): Promise<boolean> {
    const [profile] = await db.select({ appId: appProfiles.appId }).from(appProfiles).where(eq(appProfiles.appId, appId)).limit(1)
    return Boolean(profile)
}

/** Distinct app profiles that have any authorization in a workspace. */
export async function listWorkspaceApps(workspaceId: string): Promise<WorkspaceApp[]> {
    return db
        .selectDistinctOn([appProfiles.appId], {
            appId: appProfiles.appId,
            schemaNamespace: appProfiles.schemaNamespace,
            displayName: appProfiles.displayName,
            lastSeenAt: appProfiles.lastSeenAt,
        })
        .from(appProfiles)
        .innerJoin(
            userAppAuthorizations,
            and(
                eq(userAppAuthorizations.appId, appProfiles.appId),
                eq(userAppAuthorizations.workspaceId, workspaceId),
            ),
        ) as Promise<WorkspaceApp[]>
}

/** Grant (or refresh) a user's authorization for an app in a workspace. */
export async function upsertAuthorization(input: { userId: string; appId: string; workspaceId: string; scopes: string[] }): Promise<Authorization | undefined> {
    const [auth] = await db
        .insert(userAppAuthorizations)
        .values({ ...input, revokedAt: null })
        .onConflictDoUpdate({
            target: [userAppAuthorizations.userId, userAppAuthorizations.appId, userAppAuthorizations.workspaceId],
            set: { scopes: input.scopes, revokedAt: null, grantedAt: new Date() },
        })
        .returning()
    return auth
}

/** Revoke all authorizations for an app in a workspace; returns the revoked rows. */
export async function revokeApp(workspaceId: string, appId: string): Promise<Authorization[]> {
    return db
        .update(userAppAuthorizations)
        .set({ revokedAt: new Date() })
        .where(and(
            eq(userAppAuthorizations.workspaceId, workspaceId),
            eq(userAppAuthorizations.appId, appId),
        ))
        .returning()
}

/** List authorizations for an app in a workspace. */
export async function listAuthorizations(workspaceId: string, appId: string): Promise<Authorization[]> {
    return db
        .select()
        .from(userAppAuthorizations)
        .where(and(
            eq(userAppAuthorizations.workspaceId, workspaceId),
            eq(userAppAuthorizations.appId, appId),
        ))
}

/** Revoke a single user's authorization for an app; returns the updated row. */
export async function revokeUser(workspaceId: string, appId: string, userId: string): Promise<Authorization | undefined> {
    const [updated] = await db
        .update(userAppAuthorizations)
        .set({ revokedAt: new Date() })
        .where(and(
            eq(userAppAuthorizations.workspaceId, workspaceId),
            eq(userAppAuthorizations.appId, appId),
            eq(userAppAuthorizations.userId, userId),
        ))
        .returning()
    return updated
}
