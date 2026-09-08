// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the provider-instance port (Stage 3). The only instances
 * module permitted to import the ORM. The queries are the ones that used to sit
 * in `providers/instances.ts`.
 */

import { db, providerInstances } from '@plexo/db'
import { eq, and, asc, sql } from 'drizzle-orm'
import type {
    ProviderInstanceStore,
    ProviderInstanceRow,
    ProviderInstanceInsert,
    ProviderInstanceUpdate,
    PreferenceOrderUpdate,
} from './provider-instances.ports.js'

export class DrizzleProviderInstanceStore implements ProviderInstanceStore {
    async listByWorkspace(workspaceId: string): Promise<ProviderInstanceRow[]> {
        const rows = await db.select()
            .from(providerInstances)
            .where(eq(providerInstances.workspaceId, workspaceId))
            .orderBy(asc(providerInstances.preferenceOrder))
        return rows as ProviderInstanceRow[]
    }

    async getById(instanceId: string): Promise<ProviderInstanceRow | null> {
        const [row] = await db.select()
            .from(providerInstances)
            .where(eq(providerInstances.id, instanceId))
            .limit(1)
        return (row as ProviderInstanceRow) ?? null
    }

    async getOwnership(instanceId: string): Promise<{ workspaceId: string; managed: boolean } | null> {
        const [row] = await db.select({
            workspaceId: providerInstances.workspaceId,
            managed: providerInstances.managed,
        })
            .from(providerInstances)
            .where(eq(providerInstances.id, instanceId))
            .limit(1)
        return row ?? null
    }

    async maxPreferenceOrder(workspaceId: string): Promise<number | null> {
        const [row] = await db.execute<{ max_order: string | null }>(sql`
            SELECT MAX(preference_order) AS max_order
            FROM provider_instances
            WHERE workspace_id = ${workspaceId}::uuid
        `)
        const max = row?.max_order
        return max === null || max === undefined ? null : Number(max)
    }

    async insert(input: ProviderInstanceInsert): Promise<ProviderInstanceRow> {
        const [row] = await db.insert(providerInstances).values({
            workspaceId: input.workspaceId,
            nickname: input.nickname,
            providerType: input.providerType,
            endpointUrl: input.endpointUrl,
            encryptedKey: input.encryptedKey,
            selectedModel: input.selectedModel,
            managed: input.managed,
            capabilities: input.capabilities,
            preferenceOrder: input.preferenceOrder,
            lastDiscoveredAt: input.lastDiscoveredAt,
        }).returning()
        return row as ProviderInstanceRow
    }

    async update(instanceId: string, updates: ProviderInstanceUpdate): Promise<ProviderInstanceRow | null> {
        const [row] = await db.update(providerInstances)
            .set(updates)
            .where(eq(providerInstances.id, instanceId))
            .returning()
        return (row as ProviderInstanceRow) ?? null
    }

    async delete(instanceId: string): Promise<void> {
        await db.delete(providerInstances).where(eq(providerInstances.id, instanceId))
    }

    async setPreferenceOrder(workspaceId: string, instanceId: string, order: PreferenceOrderUpdate): Promise<void> {
        await db.update(providerInstances)
            .set(order)
            .where(and(
                eq(providerInstances.id, instanceId),
                eq(providerInstances.workspaceId, workspaceId),
            ))
    }
}
