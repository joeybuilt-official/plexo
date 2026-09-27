// SPDX-License-Identifier: MIT
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
import { eq, inArray, and, sql, asc } from 'drizzle-orm'
import { db } from '@plexo/db'
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

// ── Owned-workspace resolution ───────────────────────────────────────────────

/**
 * Resolve the ONE workspace a user's apps should bind to: the OLDEST they own,
 * or undefined if they own none.
 *
 * THIS MUST BE ORDERED. Both public resolvers below previously did a bare
 * `WHERE owner_id = $user LIMIT 1`, so Postgres returned whichever row the
 * planner happened to touch first — stable for a user with one workspace, but
 * arbitrary and able to flip between calls once they own more than one. Two
 * callers resolve through it, and both fail silently and destructively on a
 * flip:
 *
 *   - `POST /auth/workspace/ensure` (getOwnedWorkspaceIdName) — apps resolve
 *     their workspace through this on boot and on every OAuth reconnect, so a
 *     flip rebinds the app to a workspace with no Google token in it and every
 *     provider sync fails. Levio lost ~6 weeks of email + calendar sync this
 *     way (2026-08-11 -> 2026-09-26): its operator owned both a hand-created
 *     "Personal" workspace (holding the real connections — google-workspace,
 *     google-drive, gmessages, github, telegram, deepgram) and an app-created
 *     "Fylo" one (holding only auto-installed app profiles), and ensure()
 *     resolved the latter.
 *   - `POST /profiles/auto-attach-user` (getOwnedWorkspaceId) — a flip
 *     auto-installs the app's connection row + bridge extension into the wrong
 *     workspace, so that app's tools are invisible to the agent in the
 *     workspace the user actually works in.
 *
 * Oldest-first is the CORRECT choice, not merely a deterministic one: the first
 * workspace a user gets is the personal one they set up by hand, and it is the
 * one that holds real connections and history (in the incident above, Personal
 * held 1,383 conversations / 25,078 tasks / 11 connections against Fylo's
 * 0 / 152 / 4). Later workspaces are created by apps calling ensure() with a
 * `displayName` and hold only auto-installed app profiles. `id ASC` is a
 * tiebreak for the (rare) same-instant case so the result is fully
 * deterministic rather than merely stable-ish.
 *
 * No index on workspaces.owner_id and none added: the owned-workspace count per
 * user is a handful at most, so an ordered scan of that tiny set is free, and
 * both paths are get-or-create on boot/reconnect rather than a hot loop.
 *
 * Single source of truth on purpose — if the ordering policy is ever changed it
 * must change for BOTH resolvers at once, or the two entry points disagree and
 * the app-facing symptom returns in a new shape.
 */
async function resolveOwnedWorkspace(userId: string): Promise<{ id: string; name: string } | undefined> {
    const [existing] = await db.select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.ownerId, userId))
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
        .limit(1)
    return existing
}

/** The workspace `workspace/ensure` resolves for a user (id + name). */
export async function getOwnedWorkspaceIdName(userId: string): Promise<{ id: string; name: string } | undefined> {
    return resolveOwnedWorkspace(userId)
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

/**
 * The workspace `auto-attach-user` resolves for a user (id only).
 *
 * Same ordering contract as getOwnedWorkspaceIdName — see resolveOwnedWorkspace.
 */
export async function getOwnedWorkspaceId(userId: string): Promise<{ id: string } | undefined> {
    const ws = await resolveOwnedWorkspace(userId)
    return ws ? { id: ws.id } : undefined
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
