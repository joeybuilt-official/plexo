// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * App-Grant data-access repository — Connection & Profile Standard (ADR 0001 §3).
 *
 * owns the workspace-app-grant reads and the operator
 * upsert plus the vocabulary reads (registered apps, installed connectors,
 * enabled-extension manifests, monitor-mode observations) that back the
 * grants UI. The route keeps operator-only authz, validation, and the
 * connector/capability post-processing. All reads are workspace-scoped
 * verbatim; default-deny semantics live in the route + the upsert is exactly
 * the operator-set/widen mutation.
 */
import { db, eq, and, desc } from '@plexo/db'
import { workspaceAppGrants, appProfiles, installedConnections, extensions, profileMonitorObservations } from '@plexo/db'

/** Grant rows for a workspace, newest-updated first. */
export async function listGrants(workspaceId: string) {
    return db
        .select()
        .from(workspaceAppGrants)
        .where(eq(workspaceAppGrants.workspaceId, workspaceId))
        .orderBy(desc(workspaceAppGrants.updatedAt))
}

/** Registered apps {appId, displayName} (picker vocabulary). */
export async function listAppProfiles() {
    return db
        .select({ appId: appProfiles.appId, displayName: appProfiles.displayName })
        .from(appProfiles)
        .orderBy(appProfiles.appId)
}

/** Installed connector registryIds in a workspace (connector vocabulary). */
export async function listInstalledConnectorRegistryIds(workspaceId: string) {
    return db
        .select({ registryId: installedConnections.registryId })
        .from(installedConnections)
        .where(eq(installedConnections.workspaceId, workspaceId))
}

/** Manifests of enabled extensions in a workspace (capability vocabulary). */
export async function listEnabledExtensionManifests(workspaceId: string) {
    return db
        .select({ manifest: extensions.manifest })
        .from(extensions)
        .where(and(eq(extensions.workspaceId, workspaceId), eq(extensions.enabled, true)))
}

/** Monitor-mode observations for a workspace (gap-seeding for grants UI). */
export async function listMonitorObservations(workspaceId: string) {
    return db
        .select({
            appId: profileMonitorObservations.appId,
            kind: profileMonitorObservations.kind,
            token: profileMonitorObservations.token,
            extName: profileMonitorObservations.extName,
            observedCount: profileMonitorObservations.observedCount,
            lastSeenAt: profileMonitorObservations.lastSeenAt,
        })
        .from(profileMonitorObservations)
        .where(eq(profileMonitorObservations.workspaceId, workspaceId))
        .orderBy(profileMonitorObservations.appId)
}

/** Operator set/widen of a grant — default-deny upsert keyed (appId, workspaceId). */
export async function upsertGrant(params: {
    appId: string
    workspaceId: string
    allowedConnectors: string[]
    capabilities: string[]
    status: string
    grantedBy: string
}): Promise<void> {
    const { appId, workspaceId, allowedConnectors, capabilities, status, grantedBy } = params
    await db
        .insert(workspaceAppGrants)
        .values({ appId, workspaceId, allowedConnectors, capabilities, status, grantedBy })
        .onConflictDoUpdate({
            target: [workspaceAppGrants.appId, workspaceAppGrants.workspaceId],
            set: { allowedConnectors, capabilities, status, grantedBy, updatedAt: new Date() },
        })
}
