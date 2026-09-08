// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Provider-instance persistence port (Stage 3, providers cluster).
 *
 * `providers/instances.ts` is the read/write layer the Intelligence page sits
 * on; this port abstracts its seven table touches. The drizzle adapter
 * (`provider-instances.repository.ts`) is the only instances module permitted
 * to import the ORM. Capability discovery, the settings-cache invalidation,
 * the "new provider goes last" rule and the capability→column mapping for a
 * reorder all stay in the use case — the port moves rows, not decisions.
 */

import type { ProviderCapabilities } from './provider-discovery.ports.js'

export type ModelCompatStatus = 'native' | 'repair' | 'failed' | null

/**
 * A `provider_instances` row as the Intelligence page reads it. Hand-declared
 * rather than inferred from the table, so a schema column added tomorrow does
 * not silently widen this contract. Declared here rather than in the use case
 * so the port does not import its own consumer; `providers/instances.ts`
 * re-exports it, and every existing importer keeps its path.
 */
export interface ProviderInstanceRow {
    id: string
    workspaceId: string
    nickname: string
    providerType: string
    endpointUrl: string | null
    encryptedKey: string | null
    capabilities: ProviderCapabilities
    preferenceOrder: number
    managed: boolean
    enabled: boolean
    selectedModel: string | null
    createdAt: Date
    updatedAt: Date
    lastDiscoveredAt: Date | null
    modelCompatStatus: ModelCompatStatus
    modelCompatValidatedAt: Date | null
}

/** Everything an insert needs; the caller has already resolved the defaults. */
export interface ProviderInstanceInsert {
    workspaceId: string
    nickname: string
    providerType: string
    endpointUrl: string | null
    encryptedKey: string | null
    selectedModel: string | null
    managed: boolean
    capabilities: ProviderCapabilities
    preferenceOrder: number
    lastDiscoveredAt: Date
}

/** The mutable columns, plus the caller's `updatedAt`. */
export interface ProviderInstanceUpdate {
    nickname?: string
    endpointUrl?: string | null
    encryptedKey?: string | null
    selectedModel?: string | null
    enabled?: boolean
    modelCompatStatus?: ModelCompatStatus
    modelCompatValidatedAt?: Date | null
    updatedAt: Date
}

/** The preference columns one reorder step writes. */
export interface PreferenceOrderUpdate {
    preferenceOrder: number
    chatPreferenceOrder?: number
    embeddingPreferenceOrder?: number
    updatedAt: Date
}

export interface ProviderInstanceStore {
    /** Every instance in a workspace, ordered by `preferenceOrder` ascending. */
    listByWorkspace(workspaceId: string): Promise<ProviderInstanceRow[]>
    /** One instance by id; `null` when it does not exist. */
    getById(instanceId: string): Promise<ProviderInstanceRow | null>
    /**
     * The two facts the removal guard needs, without pulling the encrypted key.
     * `null` when the instance does not exist.
     */
    getOwnership(instanceId: string): Promise<{ workspaceId: string; managed: boolean } | null>
    /** Highest `preferenceOrder` in the workspace; `null` when it has no instances. */
    maxPreferenceOrder(workspaceId: string): Promise<number | null>
    insert(input: ProviderInstanceInsert): Promise<ProviderInstanceRow>
    /** Applies the update and returns the new row; `null` when no row matched. */
    update(instanceId: string, updates: ProviderInstanceUpdate): Promise<ProviderInstanceRow | null>
    delete(instanceId: string): Promise<void>
    /** Writes one instance's preference columns, scoped to its workspace. */
    setPreferenceOrder(workspaceId: string, instanceId: string, order: PreferenceOrderUpdate): Promise<void>
}
