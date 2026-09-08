// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Provider capability-discovery persistence port (Stage 3, providers cluster).
 *
 * `providers/discovery.ts` probes each configured provider for what it can do
 * and caches the answer on the instance row; this port abstracts the three
 * things it needs from storage. The drizzle adapter
 * (`provider-discovery.repository.ts`) is the only discovery module permitted
 * to import the ORM. Probing, decryption, the static cloud table and the
 * per-instance failure isolation stay in the use case — the port moves rows,
 * not decisions.
 */

/**
 * What a provider instance can do. Mirrors the `provider_instances.capabilities`
 * JSONB column; declared here rather than in the use case so the port does not
 * have to import its own consumer. `providers/discovery.ts` re-exports it, so
 * every existing importer keeps its import path.
 */
export interface ProviderCapabilities {
    supportsChat: boolean
    supportsEmbeddings: boolean
    chatModels: string[]
    embeddingModels: string[]
    discoveryError: string | null
}

/**
 * The `provider_instances` fields discovery actually reads. Hand-declared and
 * deliberately narrower than the row: the previous `db.select()` pulled all 22
 * columns to use five of them.
 */
export interface DiscoveryInstance {
    id: string
    workspaceId: string
    providerType: string
    endpointUrl: string | null
    encryptedKey: string | null
    managed: boolean
}

export interface ProviderDiscoveryStore {
    /** One instance by id; `null` when it does not exist. */
    getInstance(instanceId: string): Promise<DiscoveryInstance | null>
    /** Every provider instance in a workspace. */
    listWorkspaceInstances(workspaceId: string): Promise<DiscoveryInstance[]>
    /**
     * Cache a discovery result on the instance row. `discoveredAt` is supplied
     * by the caller so the stored timestamp is the moment discovery ran, not
     * the moment the write reached the adapter.
     */
    saveCapabilities(instanceId: string, capabilities: ProviderCapabilities, discoveredAt: Date): Promise<void>
}
