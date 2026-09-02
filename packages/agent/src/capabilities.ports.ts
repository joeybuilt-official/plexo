// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Persistence port for the capability manifest builder (Stage 2).
 *
 * `capabilities/manifest.ts` composes the workspace's connections, provider
 * instances, settings and extensions into a manifest; this port abstracts the
 * four reads it makes. The drizzle adapter (`capabilities.repository.ts`) is the
 * only capabilities-area module permitted to import the ORM. SSH credential
 * decryption stays in the use case — the port returns the raw stored blob.
 */

export interface ManifestConnectionRow {
    registryId: string
    name: string | null
    credentials: { encrypted?: string } | null
}

export interface ManifestProviderInstance {
    providerType: string
    selectedModel: string | null
    enabled: boolean
}

export interface ManifestExtensionRow {
    name: string
    manifest: { description?: string } | null
}

export interface ManifestStore {
    /** Active installed connections for the workspace. */
    listActiveConnections(workspaceId: string): Promise<ManifestConnectionRow[]>
    /** The workspace's `settings` JSON, or null when there is no row. */
    getWorkspaceSettings(workspaceId: string): Promise<Record<string, unknown> | null>
    /** Provider instances ordered by preference (may throw if the table is absent). */
    listProviderInstances(workspaceId: string): Promise<ManifestProviderInstance[]>
    /** Enabled skill extensions for the workspace. */
    listEnabledExtensions(workspaceId: string): Promise<ManifestExtensionRow[]>
}
