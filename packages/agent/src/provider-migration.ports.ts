// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Legacy provider-migration port (Stage 3, providers cluster).
 *
 * `providers/migrate-to-instances.ts` back-fills `provider_instances` from the
 * pre-instances vault/arbiter blob in `workspaces.settings`. The drizzle
 * adapter (`provider-migration.repository.ts`) is the only migration module
 * permitted to import the ORM. Ordering, de-duplication, the skip rules and
 * the nickname table stay in the use case — the port reads the legacy shape
 * and answers two questions about the target table.
 */

/** One vault entry: a provider's stored credential, in the legacy format. */
export interface LegacyVaultEntry {
    status?: string
    apiKey?: string
    baseUrl?: string
}

/** One arbiter provider entry: the model the workspace had picked. */
export interface LegacyArbiterProvider {
    selectedModel?: string
    defaultModel?: string
}

/**
 * The pre-instances provider config, as stored in `workspaces.settings`. Both
 * arbiter name pairs are carried because the blob is historical and uses
 * either spelling; choosing between them is the migration's job, not the
 * adapter's.
 */
export interface LegacyProviderConfig {
    vault: Record<string, LegacyVaultEntry>
    arbiter: {
        primaryProvider?: string
        primary?: string
        fallbackChain?: string[]
        fallbackOrder?: string[]
        providers?: Record<string, LegacyArbiterProvider>
    }
}

export interface ProviderMigrationStore {
    /** True when the workspace has any `provider_instances` row at all. */
    hasAnyInstances(workspaceId: string): Promise<boolean>
    /** True when it has a row the user created (i.e. it is already migrated). */
    hasUnmanagedInstances(workspaceId: string): Promise<boolean>
    /**
     * The legacy vault/arbiter config, or `null` when the workspace has no
     * settings blob to migrate from.
     */
    getLegacyProviderConfig(workspaceId: string): Promise<LegacyProviderConfig | null>
}
