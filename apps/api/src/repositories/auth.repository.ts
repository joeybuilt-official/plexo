// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Auth-route data-access repository.
 *
 * owns the raw table SQL behind the auth router's
 * service-to-service workspace/connection/extension orchestration
 * (account-cleanup, workspace/ensure, profiles/auto-attach-user, workspace
 * create). Only the SQL moved here; the route keeps ALL security/side-effect
 * logic — service-key auth, JWT/optionalAuth user resolution, permission-graph
 * mirror writes (mirrorMembershipUpsert), telemetry/audit (trackEvent),
 * analytics emits, and every validation guard. Workspace/owner scoping is
 * preserved verbatim: ownership filters use ownerId, member upserts stay
 * onConflictDoNothing, bridge lookups stay scoped by (workspaceId, name).
 */
import { db, eq, inArray, and, sql } from '@plexo/db'
import {
    workspaces,
    workspaceMembers,
    installedConnections,
    connectionsRegistry,
    extensions,
    appProfiles,
    DEFAULT_INTELLIGENCE_SETTINGS,
    DEFAULT_WORKSPACE_SETTINGS,
} from '@plexo/db'

// ── account-cleanup ──────────────────────────────────────────────────────────

/** IDs of all workspaces owned by a user. */
export async function listOwnedWorkspaceIds(userId: string): Promise<Array<{ id: string }>> {
    return db.select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.ownerId, userId))
}

/** Delete the given workspaces by ID. */
export async function deleteWorkspacesByIds(ids: string[]): Promise<void> {
    await db.delete(workspaces).where(inArray(workspaces.id, ids))
}

// ── setup-status ─────────────────────────────────────────────────────────────

/** Total workspace count (used to decide whether initial setup is needed). */
export async function countWorkspaces(): Promise<Array<{ count: number }>> {
    return db.select({ count: sql<number>`count(*)` }).from(workspaces)
}

// ── workspace/ensure ─────────────────────────────────────────────────────────

/** First workspace owned by a user (id + name), or undefined. */
export async function getOwnedWorkspaceIdName(userId: string): Promise<{ id: string; name: string } | undefined> {
    const [existing] = await db.select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.ownerId, userId))
        .limit(1)
    return existing
}

/** Create a personal workspace; returns { workspaceId, name }. */
export async function createWorkspaceReturningIdName(displayName: string, userId: string): Promise<{ workspaceId: string; name: string } | undefined> {
    const [ws] = await db.insert(workspaces).values({
        name: displayName,
        ownerId: userId,
        settings: DEFAULT_WORKSPACE_SETTINGS,
        intelligenceSettings: DEFAULT_INTELLIGENCE_SETTINGS,
    }).returning({ workspaceId: workspaces.id, name: workspaces.name })
    return ws
}

/** Seed the owner member row (idempotent). */
export async function insertOwnerMember(workspaceId: string, userId: string): Promise<void> {
    await db.insert(workspaceMembers).values({
        workspaceId,
        userId,
        role: 'owner',
    }).onConflictDoNothing()
}

// ── profiles/auto-attach-user ────────────────────────────────────────────────

/** First workspace ID owned by a user, or undefined. */
export async function getOwnedWorkspaceId(userId: string): Promise<{ id: string } | undefined> {
    const [existing] = await db.select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.ownerId, userId))
        .limit(1)
    return existing
}

/** Create a personal workspace; returns { id }. */
export async function createWorkspaceReturningId(displayName: string, userId: string): Promise<{ id: string } | undefined> {
    const [ws] = await db.insert(workspaces).values({
        name: displayName,
        ownerId: userId,
        settings: DEFAULT_WORKSPACE_SETTINGS,
        intelligenceSettings: DEFAULT_INTELLIGENCE_SETTINGS,
    }).returning({ id: workspaces.id })
    return ws
}

/** App-profile display name lookup by appId. */
export async function getAppProfileDisplayName(appId: string): Promise<{ displayName: string } | undefined> {
    const [profile] = await db.select({
        displayName: appProfiles.displayName,
    }).from(appProfiles).where(eq(appProfiles.appId, appId)).limit(1)
    return profile
}

/** connections_registry row lookup by id (= appId). */
export async function getConnectionsRegistryRow(appId: string): Promise<{ id: string } | undefined> {
    const [registryRow] = await db.select({ id: connectionsRegistry.id })
        .from(connectionsRegistry)
        .where(eq(connectionsRegistry.id, appId))
        .limit(1)
    return registryRow
}

/** Insert a minimal connections_registry row to satisfy the installed_connections FK (idempotent). */
export async function insertConnectionsRegistryRow(appId: string, displayName: string): Promise<void> {
    await db.insert(connectionsRegistry).values({
        id: appId,
        name: displayName,
        description: `${displayName} (Joeybuilt app — auto-connected)`,
        category: 'productivity',
        authType: 'none',
        oauthScopes: [],
        setupFields: [],
        toolsProvided: [],
        cardsProvided: [],
        isCore: false,
    }).onConflictDoNothing()
}

/** Idempotent insert of an installed_connections row; returns inserted IDs. */
export async function insertInstalledConnection(workspaceId: string, appId: string, displayName: string): Promise<Array<{ id: string }>> {
    return db.insert(installedConnections).values({
        workspaceId,
        registryId: appId,
        name: displayName,
        credentials: {},
        label: 'default',
        status: 'active',
        scopesGranted: [],
    }).onConflictDoNothing().returning({ id: installedConnections.id })
}

/** Bridge extension lookup scoped by (workspaceId, name). */
export async function getBridgeExtension(workspaceId: string, bridgeName: string): Promise<{ id: string; enabled: boolean } | undefined> {
    const [existingBridge] = await db.select({ id: extensions.id, enabled: extensions.enabled })
        .from(extensions)
        .where(and(eq(extensions.workspaceId, workspaceId), eq(extensions.name, bridgeName)))
        .limit(1)
    return existingBridge
}

/** Enable a bridge extension by id. */
export async function enableBridgeExtension(id: string): Promise<void> {
    await db.update(extensions)
        .set({ enabled: true })
        .where(eq(extensions.id, id))
}

/** Insert a minimal bridge extension row (idempotent). */
export async function insertBridgeExtension(params: {
    workspaceId: string
    bridgeName: string
    bridgeEntry: string
    displayName: string
}): Promise<void> {
    const { workspaceId, bridgeName, bridgeEntry, displayName } = params
    await db.insert(extensions).values({
        workspaceId,
        name: bridgeName,
        version: '1.0.0',
        type: 'tool',
        pexVersion: '0.4.0',
        entry: bridgeEntry,
        manifest: {
            plexo: '0.4.0',
            name: bridgeName,
            type: 'tool',
            version: '1.0.0',
            displayName: `${displayName} Bridge`,
            description: `Proxies tool calls to ${displayName}'s data API.`,
            entry: bridgeEntry,
            capabilities: ['storage:read'],
        },
        enabled: true,
        settings: {},
        source: 'sideloaded',
    }).onConflictDoNothing()
}

// ── workspace (setup wizard) ─────────────────────────────────────────────────

/** Create a workspace; returns { workspaceId }. */
export async function createWorkspaceReturningWorkspaceId(name: string, ownerId: string): Promise<{ workspaceId: string } | undefined> {
    const [ws] = await db.insert(workspaces).values({
        name,
        ownerId,
        settings: DEFAULT_WORKSPACE_SETTINGS,
        intelligenceSettings: DEFAULT_INTELLIGENCE_SETTINGS,
    }).returning({ workspaceId: workspaces.id })
    return ws
}
