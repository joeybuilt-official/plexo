// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Provider instance CRUD — read/write layer for the Intelligence page.
 *
 * Operates on the provider_instances table. Consumed by the Intelligence
 * page API routes (Phase 4+). Does NOT replace the existing vault/arbiter
 * system — both coexist during the transition period.
 */

import { eq, and, asc, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { providerInstances } from '@plexo/db'
import { discoverCapabilities, type ProviderCapabilities } from './discovery.js'
import { invalidateSettingsCache } from './settings-from-instances.js'
import pino from 'pino'

const logger = pino({ name: 'provider:instances' })

export interface ProviderInstanceInput {
    nickname: string
    providerType: string
    endpointUrl?: string | null
    encryptedKey?: string | null
    selectedModel?: string | null
    managed?: boolean
}

export type ModelCompatStatus = 'native' | 'repair' | 'failed' | null

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

/**
 * List all provider instances for a workspace, ordered by preference.
 */
export async function listProviders(workspaceId: string): Promise<ProviderInstanceRow[]> {
    const rows = await db.select()
        .from(providerInstances)
        .where(eq(providerInstances.workspaceId, workspaceId))
        .orderBy(asc(providerInstances.preferenceOrder))

    return rows as ProviderInstanceRow[]
}

/**
 * Get a single provider instance.
 */
export async function getProvider(instanceId: string): Promise<ProviderInstanceRow | null> {
    const [row] = await db.select()
        .from(providerInstances)
        .where(eq(providerInstances.id, instanceId))
        .limit(1)
    return (row as ProviderInstanceRow) ?? null
}

/**
 * Add a new provider instance to a workspace.
 * Automatically discovers capabilities and sets preference order to last.
 */
export async function addProvider(workspaceId: string, input: ProviderInstanceInput): Promise<ProviderInstanceRow> {
    // Get next preference order
    const [maxRow] = await db.execute<{ max_order: string }>(sql`
        SELECT COALESCE(MAX(preference_order), -1) AS max_order
        FROM provider_instances
        WHERE workspace_id = ${workspaceId}::uuid
    `)
    const nextOrder = Number(maxRow?.max_order ?? -1) + 1

    // Discover capabilities before inserting
    const caps = await discoverCapabilities({
        providerType: input.providerType,
        endpointUrl: input.endpointUrl ?? null,
        encryptedKey: input.encryptedKey ?? null,
        workspaceId,
    })

    const [row] = await db.insert(providerInstances).values({
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
    }).returning()

    invalidateSettingsCache(workspaceId)
    return row as ProviderInstanceRow
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
    const [row] = await db.update(providerInstances)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(providerInstances.id, instanceId))
        .returning()
    if (row) invalidateSettingsCache((row as ProviderInstanceRow).workspaceId)
    return (row as ProviderInstanceRow) ?? null
}

/**
 * Remove a provider instance. Rejects managed providers.
 */
export async function removeProvider(instanceId: string): Promise<void> {
    const [row] = await db.select({ managed: providerInstances.managed, workspaceId: providerInstances.workspaceId })
        .from(providerInstances)
        .where(eq(providerInstances.id, instanceId))
        .limit(1)

    if (!row) throw new Error(`Provider instance ${instanceId} not found`)
    if (row.managed) throw new Error('Cannot remove the managed provider. It is a built-in default.')

    await db.delete(providerInstances).where(eq(providerInstances.id, instanceId))
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
        const updates: Record<string, unknown> = { updatedAt: new Date(), preferenceOrder: i }
        if (capability === 'chat') updates.chatPreferenceOrder = i
        else if (capability === 'embedding') updates.embeddingPreferenceOrder = i
        else { updates.chatPreferenceOrder = i; updates.embeddingPreferenceOrder = i }

        await db.update(providerInstances)
            .set(updates)
            .where(and(
                eq(providerInstances.id, orderedIds[i]!),
                eq(providerInstances.workspaceId, workspaceId),
            ))
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
