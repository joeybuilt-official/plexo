// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Provider instance CRUD — read/write layer for the Intelligence page.
 *
 * Operates on the provider_instances table. Consumed by the Intelligence
 * page API routes (Phase 4+). Does NOT replace the existing vault/arbiter
 * system — both coexist during the transition period.
 *
 * Persistence sits behind `ProviderInstanceStore`
 * (`../provider-instances.ports.js`); the drizzle adapter is
 * `../provider-instances.repository.js`.
 */

import { discoverCapabilities } from './discovery.js'
import { invalidateSettingsCache } from './settings-from-instances.js'
import { DrizzleProviderInstanceStore } from '../provider-instances.repository.js'
import type {
    ProviderInstanceStore,
    ProviderInstanceRow,
    PreferenceOrderUpdate,
    ModelCompatStatus,
} from '../provider-instances.ports.js'
import pino from 'pino'

const logger = pino({ name: 'provider:instances' })

// Declared on the port so it does not have to import its consumer; re-exported
// here so every existing importer keeps its path.
export type { ProviderInstanceRow, ModelCompatStatus } from '../provider-instances.ports.js'

// ── Composition root + test seam ───────────────────────────────────

let store: ProviderInstanceStore = new DrizzleProviderInstanceStore()

/** Swap the provider-instance store (e.g. an in-memory fake in unit tests). */
export function setProviderInstanceStore(next: ProviderInstanceStore): void {
    store = next
}

export interface ProviderInstanceInput {
    nickname: string
    providerType: string
    endpointUrl?: string | null
    encryptedKey?: string | null
    selectedModel?: string | null
    managed?: boolean
}

/**
 * List all provider instances for a workspace, ordered by preference.
 */
export async function listProviders(workspaceId: string): Promise<ProviderInstanceRow[]> {
    return store.listByWorkspace(workspaceId)
}

/**
 * Get a single provider instance.
 */
export async function getProvider(instanceId: string): Promise<ProviderInstanceRow | null> {
    return store.getById(instanceId)
}

/**
 * Add a new provider instance to a workspace.
 * Automatically discovers capabilities and sets preference order to last.
 */
export async function addProvider(workspaceId: string, input: ProviderInstanceInput): Promise<ProviderInstanceRow> {
    // A new provider goes last.
    const nextOrder = (await store.maxPreferenceOrder(workspaceId) ?? -1) + 1

    // Discover capabilities before inserting
    const caps = await discoverCapabilities({
        providerType: input.providerType,
        endpointUrl: input.endpointUrl ?? null,
        encryptedKey: input.encryptedKey ?? null,
        workspaceId,
        managed: input.managed ?? false,
    })

    const row = await store.insert({
        workspaceId,
        nickname: input.nickname,
        providerType: input.providerType,
        endpointUrl: input.endpointUrl ?? null,
        encryptedKey: input.encryptedKey ?? null,
        selectedModel: input.selectedModel ?? null,
        managed: input.managed ?? false,
        capabilities: caps,
        preferenceOrder: nextOrder,
        lastDiscoveredAt: new Date(),
    })

    invalidateSettingsCache(workspaceId)
    return row
}

/**
 * Update a provider instance.
 */
export async function updateProvider(instanceId: string, updates: Partial<{
    nickname: string
    endpointUrl: string | null
    encryptedKey: string | null
    selectedModel: string | null
    enabled: boolean
    modelCompatStatus: ModelCompatStatus
    modelCompatValidatedAt: Date | null
}>): Promise<ProviderInstanceRow | null> {
    const row = await store.update(instanceId, { ...updates, updatedAt: new Date() })
    if (row) invalidateSettingsCache(row.workspaceId)
    return row
}

/**
 * Remove a provider instance. Rejects managed providers.
 */
export async function removeProvider(instanceId: string): Promise<void> {
    const row = await store.getOwnership(instanceId)

    if (!row) throw new Error(`Provider instance ${instanceId} not found`)
    if (row.managed) throw new Error('Cannot remove the managed provider. It is a built-in default.')

    await store.delete(instanceId)
    invalidateSettingsCache(row.workspaceId)
}

/**
 * Reorder provider instances for a specific capability section.
 * @param capability - 'chat' for Thinking section, 'embedding' for Memory section, or 'global' for legacy
 */
export async function reorderProviders(workspaceId: string, orderedIds: string[], capability: 'chat' | 'embedding' | 'global' = 'global'): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
        // `preferenceOrder` is the column the AI runtime actually reads
        // (loadSettingsFromInstances sorts by it), so every reorder — regardless
        // of UI capability — must persist it. The capability-specific columns
        // are kept for UI sort stability within the Thinking / Memory sections.
        const order: PreferenceOrderUpdate = { updatedAt: new Date(), preferenceOrder: i }
        if (capability === 'chat') order.chatPreferenceOrder = i
        else if (capability === 'embedding') order.embeddingPreferenceOrder = i
        else { order.chatPreferenceOrder = i; order.embeddingPreferenceOrder = i }

        await store.setPreferenceOrder(workspaceId, orderedIds[i]!, order)
    }
    invalidateSettingsCache(workspaceId)
}

/**
 * Seed the managed Ollama provider for a workspace.
 * Idempotent — skips if already exists.
 */


// Re-export for consumers
export { refreshInstanceCapabilities, refreshWorkspaceCapabilities } from './discovery.js'
export type { ProviderCapabilities } from './discovery.js'
