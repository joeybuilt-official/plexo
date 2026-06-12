// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Embeddings provider data-access repository.
 *
 * arch-findings B1 — owns the provider_instances reads/writes + the workspace
 * intelligence-settings reembed-job persistence the embeddings routes perform.
 * Health derivation, capability mapping, and job orchestration stay in the route.
 */
import { db, eq, sql } from '@plexo/db'
import { providerInstances, workspaces } from '@plexo/db'

type ProviderInstance = typeof providerInstances.$inferSelect
type IntelligenceSettings = typeof workspaces.$inferSelect['intelligenceSettings']

/** All provider instances for a workspace. */
export async function listProviderInstances(workspaceId: string): Promise<ProviderInstance[]> {
    return db.select().from(providerInstances).where(eq(providerInstances.workspaceId, workspaceId))
}

/** A single provider instance by id (route does the workspace-ownership check). */
export async function getProviderInstance(instanceId: string): Promise<ProviderInstance | undefined> {
    const [row] = await db.select().from(providerInstances).where(eq(providerInstances.id, instanceId)).limit(1)
    return row
}

/** Update a provider instance's embedding model + dimensions; returns the row. */
export async function updateEmbeddingModel(instanceId: string, embeddingModel: string, embeddingDimensions: number | null): Promise<ProviderInstance | undefined> {
    const [updated] = await db
        .update(providerInstances)
        .set({ embeddingModel, embeddingDimensions, updatedAt: new Date() })
        .where(eq(providerInstances.id, instanceId))
        .returning()
    return updated
}

/** Persist an in-progress reembed jobId on the workspace's intelligence settings. */
export async function setReembedInProgressJobId(workspaceId: string, jobId: string): Promise<void> {
    await db.execute(sql`
        UPDATE workspaces
        SET intelligence_settings = jsonb_set(
            COALESCE(intelligence_settings, '{}'::jsonb),
            '{reembed,inProgressJobId}',
            ${JSON.stringify(jobId)}::jsonb,
            true
        )
        WHERE id = ${workspaceId}::uuid
    `)
}

/** A workspace's intelligence settings JSON. */
export async function getIntelligenceSettings(workspaceId: string): Promise<{ settings: IntelligenceSettings } | undefined> {
    const [row] = await db.select({ settings: workspaces.intelligenceSettings }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return row
}
