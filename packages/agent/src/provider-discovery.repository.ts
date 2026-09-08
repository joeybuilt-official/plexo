// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the provider capability-discovery port (Stage 3). The
 * only discovery module permitted to import the ORM. The queries are the ones
 * that used to sit in `providers/discovery.ts`, narrowed to the columns the
 * caller reads.
 */

import { db, providerInstances } from '@plexo/db'
import { eq } from 'drizzle-orm'
import type {
    ProviderDiscoveryStore,
    DiscoveryInstance,
    ProviderCapabilities,
} from './provider-discovery.ports.js'

const INSTANCE_COLUMNS = {
    id: providerInstances.id,
    workspaceId: providerInstances.workspaceId,
    providerType: providerInstances.providerType,
    endpointUrl: providerInstances.endpointUrl,
    encryptedKey: providerInstances.encryptedKey,
    managed: providerInstances.managed,
}

export class DrizzleProviderDiscoveryStore implements ProviderDiscoveryStore {
    async getInstance(instanceId: string): Promise<DiscoveryInstance | null> {
        const [row] = await db.select(INSTANCE_COLUMNS)
            .from(providerInstances)
            .where(eq(providerInstances.id, instanceId))
            .limit(1)
        return row ?? null
    }

    async listWorkspaceInstances(workspaceId: string): Promise<DiscoveryInstance[]> {
        return db.select(INSTANCE_COLUMNS)
            .from(providerInstances)
            .where(eq(providerInstances.workspaceId, workspaceId))
    }

    async saveCapabilities(instanceId: string, capabilities: ProviderCapabilities, discoveredAt: Date): Promise<void> {
        await db.update(providerInstances)
            .set({
                capabilities,
                lastDiscoveredAt: discoveredAt,
                updatedAt: discoveredAt,
            })
            .where(eq(providerInstances.id, instanceId))
    }
}
