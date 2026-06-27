// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Embedding router — collapsed 2026-06-27 (operator panel 5/5).
 *
 * Canonical embedding path is the bundled Plexo Inference Gateway
 * (`apps/embeddings/`). The router returns a single GatewayEmbeddingAdapter
 * keyed off the gateway URL; BYOK provider chains, workspace AI settings
 * embedder pick, and the Xenova/Ollama paths were removed.
 *
 * Gateway URL resolution order (first non-empty wins):
 *   1. EMBEDDINGS_URL
 *   2. EMBEDDINGS_SERVER_URL
 *   3. INFERENCE_GATEWAY_URL (deprecated alias, kept one release)
 *   4. http://embeddings:8082 (default for the bundled docker-compose service)
 *
 * Stored vectors are vector(384) with HNSW indexes; the gateway dimension is
 * also 384 — there's no mixed-dimension risk to manage.
 */

import pino from 'pino'
import type { WorkspaceAISettings } from '../providers/registry.js'
import {
    type EmbeddingAdapter,
    type EmbeddingProviderStatus,
    GatewayEmbeddingAdapter,
    DEFAULT_EMBEDDING_MODELS,
} from './adapters.js'

const logger = pino({ name: 'embeddings:router' })

const DEFAULT_GATEWAY_URL = 'http://embeddings:8082'

export interface EmbeddingResolution {
    adapter: EmbeddingAdapter
    status: EmbeddingProviderStatus
    message: string | null
}

export interface EmbeddingRouterResult {
    /** The resolved adapter (always the gateway after the 2026-06-27 collapse). */
    adapter: EmbeddingAdapter | null
    /** Provider ID of the resolved adapter. */
    providerId: string | null
    /** Embedding model used. */
    model: string | null
    /** Dimension count of the resolved adapter. */
    dimensions: number | null
    /** Status for introspection. */
    status: EmbeddingProviderStatus
    /** Human-readable explanation. */
    message: string | null
}

function resolveGatewayUrl(): string {
    return (
        process.env.EMBEDDINGS_URL
        ?? process.env.EMBEDDINGS_SERVER_URL
        ?? process.env.INFERENCE_GATEWAY_URL
        ?? DEFAULT_GATEWAY_URL
    )
}

function buildGatewayResult(url: string): EmbeddingRouterResult {
    const defaults = DEFAULT_EMBEDDING_MODELS['plexo-gateway']
    const adapter = new GatewayEmbeddingAdapter(
        url,
        defaults?.model ?? 'plexo-embed-v1',
        defaults?.dimensions ?? 384,
    )
    return {
        adapter,
        providerId: adapter.providerId,
        model: adapter.model,
        dimensions: adapter.dimensions,
        status: 'active',
        message: 'Resolved from Plexo embeddings gateway',
    }
}

/**
 * Resolve the embedding adapter for a workspace.
 *
 * The `aiSettings` argument is accepted for backward compatibility with
 * callers that still pass it; it is ignored now that the router is provider-
 * agnostic. Always returns the bundled gateway adapter.
 */
export function resolveEmbeddingAdapter(
    workspaceId: string,
    _aiSettings: WorkspaceAISettings | null,
): EmbeddingRouterResult {
    const url = resolveGatewayUrl()
    const result = buildGatewayResult(url)
    logger.info({ workspaceId, url, provider: result.providerId, dimensions: result.dimensions }, 'Embedding adapter resolved (gateway)')
    return result
}

/**
 * Resolve without workspace settings (kept for callers that explicitly want
 * the env-only path). Identical to `resolveEmbeddingAdapter(workspaceId, null)`.
 */
export function resolveEmbeddingAdapterFromEnv(workspaceId: string): EmbeddingRouterResult {
    return resolveEmbeddingAdapter(workspaceId, null)
}

/**
 * Async resolver. Returns the single gateway adapter. The optional
 * `aiSettings` argument is accepted for backward compatibility and ignored.
 */
export async function resolveEmbeddingAdapterAsync(
    workspaceId: string,
    _aiSettings?: WorkspaceAISettings | null,
): Promise<EmbeddingRouterResult> {
    return resolveEmbeddingAdapter(workspaceId, null)
}

// ── Dimension consistency check ─────────────────────────────────────────────

export interface DimensionCheck {
    compatible: boolean
    currentDimensions: number
    recordDimensions: number | null
    message: string | null
}

/**
 * Check if the current embedding provider's dimensions match what's stored
 * in the Golden Record. If they don't match, mutations should be refused.
 */
export function checkDimensionCompatibility(
    adapterDimensions: number,
    recordEmbeddingDimensions: number | undefined | null,
): DimensionCheck {
    if (!recordEmbeddingDimensions) {
        return {
            compatible: true,
            currentDimensions: adapterDimensions,
            recordDimensions: null,
            message: null,
        }
    }

    if (adapterDimensions === recordEmbeddingDimensions) {
        return {
            compatible: true,
            currentDimensions: adapterDimensions,
            recordDimensions: recordEmbeddingDimensions,
            message: null,
        }
    }

    return {
        compatible: false,
        currentDimensions: adapterDimensions,
        recordDimensions: recordEmbeddingDimensions,
        message: `Embedding dimension mismatch: current provider produces ${adapterDimensions}-dim vectors but Golden Record contains ${recordEmbeddingDimensions}-dim vectors. Re-embedding required before new mutations can be applied.`,
    }
}

/**
 * Check if the current provider matches the Golden Record's recorded lineage.
 * Same-dimension different-provider produces vectors in different embedding spaces.
 */
export function checkProviderLineage(
    currentProvider: string,
    currentDimensions: number,
    record: { embeddingProvider?: string; embeddingModel?: string; embeddingDimensions?: number },
): DimensionCheck & { providerChanged: boolean } {
    const dimCheck = checkDimensionCompatibility(currentDimensions, record.embeddingDimensions)

    if (!record.embeddingProvider) {
        return { ...dimCheck, providerChanged: false }
    }

    const providerChanged = record.embeddingProvider !== currentProvider
    if (providerChanged && dimCheck.compatible) {
        return {
            compatible: true,
            currentDimensions,
            recordDimensions: record.embeddingDimensions ?? null,
            message: `Warning: embedding provider changed from ${record.embeddingProvider} to ${currentProvider}. Vectors may be in different semantic spaces even though dimensions match (${currentDimensions}). Consider re-embedding for best accuracy.`,
            providerChanged: true,
        }
    }

    return { ...dimCheck, providerChanged }
}

// Re-export for convenience
export { HashEmbeddingAdapter, GatewayEmbeddingAdapter } from './adapters.js'
export type { EmbeddingAdapter } from './adapters.js'
