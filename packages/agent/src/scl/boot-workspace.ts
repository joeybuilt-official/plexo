// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace boot protocol for SCL.
 *
 * When scl_enabled flips to true, this generates embeddings for the
 * workspace's spirit anchors, calls boot() from scl-core, and persists
 * the resulting Golden Record.
 */

import { boot } from '@plexo/scl-core'
import type { BootConfig, ConceptType } from '@plexo/scl-core'
import { saveGoldenRecord } from './storage.js'
import { db, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import pino from 'pino'

const logger = pino({ name: 'scl:boot-workspace' })

/**
 * Default spirit anchors for any workspace.
 * These are the foundational concepts that define the agent's identity.
 * Derived from Phase 0 Key Decision: 6 spirit concepts.
 */
const DEFAULT_SPIRIT_LABELS: Array<{ label: string; type: ConceptType }> = [
    { label: 'I am Plexo — a personal AI agent', type: 'entity' },
    { label: 'Sovereignty — I act first, report results, no permission-seeking', type: 'state' },
    { label: 'Self-learning — I improve from every interaction', type: 'action' },
    // Tool-use capability anchor: ensures task stimuli involving tools, code execution,
    // and external APIs activate a spirit region, keeping tool-execution knowledge
    // semantically adjacent to the agent's core identity.
    { label: 'I execute tasks using tools, code execution, and external APIs', type: 'action' },
    // Communication anchor: chat/explanation tasks ("explain X", "summarize Y") score
    // very low against the task/sovereignty anchors, so conversational stimuli never
    // activate the spirit region without this anchor.
    { label: 'I communicate, explain, and answer questions clearly', type: 'action' },
]

/**
 * Boot a workspace's Golden Record.
 *
 * 1. Loads workspace name/purpose for additional spirit anchors
 * 2. Generates embeddings for all spirit anchor labels
 * 3. Calls boot() from scl-core
 * 4. Persists the Golden Record to workspace_mindsets
 */
export async function bootWorkspaceGoldenRecord(
    workspaceId: string,
    embeddingProvider?: { embed(text: string): Promise<number[]> },
): Promise<void> {
    // If no provider passed, resolve one automatically
    if (!embeddingProvider) {
        const { resolveEmbeddingProvider } = await import('./embedding-provider.js')
        embeddingProvider = await resolveEmbeddingProvider(workspaceId)
    }
    logger.info({ workspaceId }, 'Booting workspace Golden Record')

    // Load workspace metadata for additional anchors
    const rows = await db.select({
        name: workspaces.name,
        settings: workspaces.settings,
    })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)

    const workspace = rows[0]
    const settings = workspace?.settings as Record<string, unknown> | null

    // Build spirit anchor labels
    const anchorLabels: Array<{ label: string; type: ConceptType }> = [...DEFAULT_SPIRIT_LABELS]

    // Add workspace-specific identity
    if (workspace?.name) {
        anchorLabels.push({
            label: `Workspace: ${workspace.name}`,
            type: 'entity' as const,
        })
    }

    // Add owner identity if configured
    const ownerName = settings?.agentPersona as string | undefined
    if (ownerName) {
        anchorLabels.push({
            label: `Operator: ${ownerName}`,
            type: 'entity' as const,
        })
    }

    // Add purpose if configured
    const purpose = settings?.agentTagline as string | undefined
    if (purpose) {
        anchorLabels.push({
            label: `Purpose: ${purpose}`,
            type: 'claim' as const,
        })
    }

    // Generate embeddings for all anchors
    const spiritAnchors: BootConfig['spiritAnchors'] = []
    for (const anchor of anchorLabels) {
        try {
            const position = await embeddingProvider.embed(anchor.label)
            spiritAnchors.push({
                label: anchor.label,
                type: anchor.type,
                position,
            })
        } catch (err) {
            logger.warn({ err, label: anchor.label }, 'Failed to embed spirit anchor — skipping')
        }
    }

    if (spiritAnchors.length === 0) {
        throw new Error('No spirit anchors could be embedded — cannot boot Golden Record')
    }

    // Boot the Golden Record
    const record = boot({
        workspaceId,
        spiritAnchors,
    })

    // Record embedding provider lineage
    try {
        const { resolveEmbeddingAdapterAsync } = await import('../embeddings/router.js')
        const resolution = await resolveEmbeddingAdapterAsync(workspaceId)
        if (resolution.status === 'active' && resolution.providerId) {
            record.embeddingProvider = resolution.providerId
            record.embeddingModel = resolution.model ?? undefined
            record.embeddingDimensions = resolution.dimensions ?? undefined
        }
    } catch { /* non-fatal — lineage is informational */ }

    // Persist
    await saveGoldenRecord(workspaceId, record)

    logger.info({
        workspaceId,
        attractors: record.attractors.length,
        regions: record.regions.length,
    }, 'Workspace Golden Record booted successfully')
}

/**
 * Re-embed all attractors and region centroids in an existing Golden Record
 * using the current embedding provider. Preserves all metadata (mutation counts,
 * depth classes, salience, etc.) — only replaces position vectors.
 *
 * Use when the embedding provider changes or when booted vectors used a
 * different model (e.g. hash-based 256-dim → ONNX 384-dim).
 */
export async function reembedGoldenRecord(
    workspaceId: string,
    embeddingProvider?: { embed(text: string): Promise<number[]> },
): Promise<{ reembedded: number; failed: number }> {
    const { loadGoldenRecord } = await import('./storage.js')
    const record = await loadGoldenRecord(workspaceId)
    if (!record) throw new Error(`No Golden Record for workspace ${workspaceId}`)

    if (!embeddingProvider) {
        const { resolveEmbeddingProvider } = await import('./embedding-provider.js')
        embeddingProvider = await resolveEmbeddingProvider(workspaceId)
    }

    let reembedded = 0
    let failed = 0

    // Re-embed all attractors
    for (const attractor of record.attractors) {
        try {
            attractor.position = await embeddingProvider.embed(attractor.label)
            reembedded++
        } catch (err) {
            logger.warn({ err, label: attractor.label }, 'Failed to re-embed attractor')
            failed++
        }
    }

    // Re-compute region centroids from their attractors
    for (const region of record.regions) {
        const regionAttractors = record.attractors.filter(a => a.regionId === region.id)
        if (regionAttractors.length === 0) continue
        const dim = regionAttractors[0]!.position.length
        const centroid = new Array(dim).fill(0)
        for (const a of regionAttractors) {
            for (let i = 0; i < dim; i++) {
                centroid[i] += (a.position[i] ?? 0) / regionAttractors.length
            }
        }
        region.centroid = centroid
    }

    // Update embedding lineage
    try {
        const { resolveEmbeddingAdapterAsync } = await import('../embeddings/router.js')
        const resolution = await resolveEmbeddingAdapterAsync(workspaceId)
        if (resolution.status === 'active' && resolution.providerId) {
            record.embeddingProvider = resolution.providerId
            record.embeddingModel = resolution.model ?? undefined
            record.embeddingDimensions = resolution.dimensions ?? undefined
        }
    } catch { /* non-fatal */ }

    await saveGoldenRecord(workspaceId, record)

    logger.info({
        workspaceId,
        reembedded,
        failed,
        dimensions: record.attractors[0]?.position.length,
        provider: record.embeddingProvider,
    }, 'Golden Record re-embedded')

    return { reembedded, failed }
}
