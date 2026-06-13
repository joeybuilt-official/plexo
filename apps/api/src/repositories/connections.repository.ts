// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Integrations (connections) data-access repository.
 *
 * arch-findings B1 — owns the connections_registry / installed_connections /
 * channels / paired_sessions table SQL behind the integrations routes. The
 * route keeps all of the side-effects: credential encryption/decryption,
 * SSRF guards, OAuth/token shaping, MCP discovery + channel-bridge wiring,
 * sandbox/sidecar probes, analytics, and audit. Workspace scoping is preserved
 * verbatim — every installed-connection read/write is filtered by workspaceId
 * exactly as the route had it.
 */
import { db, eq, and } from '@plexo/db'
import { connectionsRegistry, installedConnections, channels, pairedSessions } from '@plexo/db'

/** All registry rows (cap 500). */
export async function listRegistry() {
    return db.select().from(connectionsRegistry).limit(500)
}

/** Single registry row by id, or undefined. */
export async function getRegistryById(id: string) {
    const [item] = await db.select().from(connectionsRegistry).where(eq(connectionsRegistry.id, id)).limit(1)
    return item
}

/** Lightweight registry {id,name,authType,category} for the install flow, or undefined. */
export async function getRegistryInstallMeta(registryId: string) {
    const [reg] = await db.select({ id: connectionsRegistry.id, name: connectionsRegistry.name, authType: connectionsRegistry.authType, category: connectionsRegistry.category })
        .from(connectionsRegistry).where(eq(connectionsRegistry.id, registryId)).limit(1)
    return reg
}

/** All registry {id,category,isGenerated} rows (for the mcp-config join). */
export async function listRegistryMcpMeta() {
    return db.select({
        id: connectionsRegistry.id,
        category: connectionsRegistry.category,
        isGenerated: connectionsRegistry.isGenerated,
    }).from(connectionsRegistry)
}

/** The encrypted credentials blob for an active workspace integration by registryId, or undefined. */
export async function getActiveCredentialsByRegistry(workspaceId: string, registryId: string) {
    const [row] = await db.select({
        credentials: installedConnections.credentials,
    }).from(installedConnections)
        .where(and(
            eq(installedConnections.workspaceId, workspaceId),
            eq(installedConnections.registryId, registryId),
            eq(installedConnections.status, 'active'),
        ))
        .limit(1)
    return row
}

/** Installed-integration list columns for a workspace. */
export async function listInstalled(workspaceId: string) {
    return db.select({
        id: installedConnections.id,
        registryId: installedConnections.registryId,
        name: installedConnections.name,
        label: installedConnections.label,
        status: installedConnections.status,
        enabledTools: installedConnections.enabledTools,
        scopesGranted: installedConnections.scopesGranted,
        lastVerifiedAt: installedConnections.lastVerifiedAt,
        createdAt: installedConnections.createdAt,
    }).from(installedConnections)
        .where(eq(installedConnections.workspaceId, workspaceId))
}

/** Insert an installed connection, returning {id}, or undefined. */
export async function insertInstalled(values: typeof installedConnections.$inferInsert) {
    const [installed] = await db.insert(installedConnections).values(values).returning({ id: installedConnections.id })
    return installed
}

/** Insert a bridged channel (skip on conflict), returning {id}, or undefined. */
export async function insertBridgedChannel(values: typeof channels.$inferInsert) {
    const [ch] = await db.insert(channels).values(values).onConflictDoNothing().returning({ id: channels.id })
    return ch
}

/** Replace the enabled-tools list on an installed connection by id. */
export async function setEnabledToolsById(id: string, enabledTools: string[]): Promise<void> {
    await db.update(installedConnections)
        .set({ enabledTools })
        .where(eq(installedConnections.id, id))
}

/** Apply a partial update to a workspace-scoped installed connection. */
export async function updateInstalledScoped(id: string, workspaceId: string, set: Record<string, unknown>): Promise<void> {
    await db.update(installedConnections)
        .set(set)
        .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))
}

/** {id,registryId,enabledTools} for a workspace-scoped installed connection, or undefined. */
export async function getInstalledToolsScoped(id: string, workspaceId: string) {
    const [row] = await db.select({
        id: installedConnections.id,
        registryId: installedConnections.registryId,
        enabledTools: installedConnections.enabledTools,
    })
        .from(installedConnections)
        .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))
        .limit(1)
    return row
}

/** Replace the enabled-tools list on a workspace-scoped installed connection. */
export async function setEnabledToolsScoped(id: string, workspaceId: string, next: string[] | null): Promise<void> {
    await db.update(installedConnections)
        .set({ enabledTools: next })
        .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))
}

/** {registryId} for a workspace-scoped installed connection, or undefined. */
export async function getInstalledRegistryIdScoped(id: string, workspaceId: string) {
    const [conn] = await db.select({ registryId: installedConnections.registryId })
        .from(installedConnections)
        .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))
        .limit(1)
    return conn
}

/** Hard-delete a workspace-scoped installed connection. */
export async function deleteInstalledScoped(id: string, workspaceId: string): Promise<void> {
    await db.delete(installedConnections)
        .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))
}

/** Delete the bridged channel for a workspace + channel-type (uninstall cleanup). */
export async function deleteBridgedChannel(workspaceId: string, type: typeof channels.$inferInsert['type']): Promise<void> {
    await db.delete(channels)
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.type, type)))
}

/** {registryId,credentials,status} rows for every workspace integration (mcp-config). */
export async function listInstalledForMcpConfig(workspaceId: string) {
    return db.select({
        registryId: installedConnections.registryId,
        credentials: installedConnections.credentials,
        status: installedConnections.status,
    }).from(installedConnections)
        .where(eq(installedConnections.workspaceId, workspaceId))
}

/**
 * Credential/scope row for the service-to-service token endpoint, or undefined.
 * When connectionId is provided, scopes to that exact installed connection.
 */
export async function getTokenRow(workspaceId: string, registryId: string, connectionId?: string) {
    const conditions = [
        eq(installedConnections.workspaceId, workspaceId),
        eq(installedConnections.registryId, registryId),
        eq(installedConnections.status, 'active'),
    ]
    if (connectionId) {
        conditions.push(eq(installedConnections.id, connectionId))
    }
    const [row] = await db.select({
        credentials: installedConnections.credentials,
        status: installedConnections.status,
        scopesGranted: installedConnections.scopesGranted,
        lastVerifiedAt: installedConnections.lastVerifiedAt,
    }).from(installedConnections)
        .where(and(...conditions))
        .limit(1)
    return row
}

/** {id,credentials} for all active connections of a registryId in a workspace (multi-account tokens). */
export async function listActiveCredentials(workspaceId: string, registryId: string) {
    return db.select({
        id: installedConnections.id,
        credentials: installedConnections.credentials,
    }).from(installedConnections)
        .where(and(
            eq(installedConnections.workspaceId, workspaceId),
            eq(installedConnections.registryId, registryId),
            eq(installedConnections.status, 'active'),
        ))
}

/** Insert a generated custom registry entry. */
export async function insertCustomRegistry(values: typeof connectionsRegistry.$inferInsert): Promise<void> {
    await db.insert(connectionsRegistry).values(values)
}

/** {credentials,registryId} for a workspace-scoped connection (test endpoint), or undefined. */
export async function getInstalledForTest(connectionId: string, workspaceId: string) {
    const [row] = await db.select({
        credentials: installedConnections.credentials,
        registryId: installedConnections.registryId,
    }).from(installedConnections)
        .where(and(eq(installedConnections.id, connectionId), eq(installedConnections.workspaceId, workspaceId)))
        .limit(1)
    return row
}

/** Paired-session state row for a gmessages connection (test endpoint), or undefined. */
export async function getPairedSessionForTest(connectionId: string, workspaceId: string) {
    const [session] = await db.select({
        state: pairedSessions.state,
        errorDetail: pairedSessions.errorDetail,
        lastInboundAt: pairedSessions.lastInboundAt,
    }).from(pairedSessions)
        .where(and(
            eq(pairedSessions.installedConnectionId, connectionId),
            eq(pairedSessions.workspaceId, workspaceId),
        ))
        .limit(1)
    return session
}
