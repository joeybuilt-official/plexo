// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the capability-manifest port (Stage 2). The only
 * capabilities-area module permitted to import the ORM.
 */

import { db, installedConnections, workspaces, extensions, providerInstances } from '@plexo/db'
import { eq, and, asc } from 'drizzle-orm'
import type {
    ManifestStore,
    ManifestConnectionRow,
    ManifestProviderInstance,
    ManifestExtensionRow,
} from './capabilities.ports.js'

export class DrizzleManifestStore implements ManifestStore {
    async listActiveConnections(workspaceId: string): Promise<ManifestConnectionRow[]> {
        const rows = await db
            .select({
                registryId: installedConnections.registryId,
                name: installedConnections.name,
                credentials: installedConnections.credentials,
            })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.status, 'active'),
            ))
        return rows.map(r => ({
            registryId: r.registryId,
            name: r.name ?? null,
            credentials: r.credentials as { encrypted?: string } | null,
        }))
    }

    async getWorkspaceSettings(workspaceId: string): Promise<Record<string, unknown> | null> {
        const [row] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)
        return (row?.settings as Record<string, unknown> | null) ?? null
    }

    async listProviderInstances(workspaceId: string): Promise<ManifestProviderInstance[]> {
        const rows = await db.select({
            providerType: providerInstances.providerType,
            selectedModel: providerInstances.selectedModel,
            enabled: providerInstances.enabled,
        }).from(providerInstances)
            .where(eq(providerInstances.workspaceId, workspaceId))
            .orderBy(asc(providerInstances.preferenceOrder))
        return rows.map(r => ({
            providerType: r.providerType,
            selectedModel: r.selectedModel ?? null,
            enabled: r.enabled,
        }))
    }

    async listEnabledExtensions(workspaceId: string): Promise<ManifestExtensionRow[]> {
        const rows = await db
            .select({
                name: extensions.name,
                manifest: extensions.manifest,
            })
            .from(extensions)
            .where(and(
                eq(extensions.workspaceId, workspaceId),
                eq(extensions.enabled, true),
            ))
        return rows.map(r => ({
            name: r.name,
            manifest: r.manifest as { description?: string } | null,
        }))
    }
}
