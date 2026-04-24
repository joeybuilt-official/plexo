// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL Embedding Provider — bridges the EmbeddingRouter to the
 * scl-core EmbeddingProvider interface.
 *
 * Delegates to the provider-agnostic EmbeddingRouter. Hash fallback
 * only fires when no configured provider supports embeddings, and
 * it's always logged at WARN level.
 */

import type { EmbeddingProvider } from '@plexo/scl-core'
import type { WorkspaceAISettings } from '../providers/registry.js'
import {
    resolveEmbeddingAdapterAsync,
    HashEmbeddingAdapter,
    type EmbeddingRouterResult,
} from '../embeddings/router.js'
import pino from 'pino'

const logger = pino({ name: 'scl:embedding-provider' })

/**
 * Resolve the best available embedding provider for a workspace.
 * Returns an scl-core compatible EmbeddingProvider.
 *
 * @param workspaceId - workspace to resolve for
 * @param aiSettings - optional workspace AI settings (if already loaded)
 */
export async function resolveEmbeddingProvider(
    workspaceId: string,
    aiSettings?: WorkspaceAISettings | null,
): Promise<EmbeddingProvider & { resolution: EmbeddingRouterResult }> {
    const resolution = await resolveEmbeddingAdapterAsync(workspaceId, aiSettings)

    if (resolution.adapter && resolution.status === 'active') {
        return {
            resolution,
            dimensions() { return resolution.dimensions! },
            async embed(text: string) { return resolution.adapter!.embed(text) },
        }
    }

    // Hash fallback — always loudly logged by the router
    logger.warn({
        workspaceId,
        status: resolution.status,
        message: resolution.message,
    }, 'SCL using hash vectors — semantic matching is disabled. Configure an embeddings-capable provider.')

    const hash = new HashEmbeddingAdapter()
    return {
        resolution: {
            ...resolution,
            adapter: hash,
            providerId: 'hash-fallback',
            model: 'deterministic-hash',
            dimensions: hash.dimensions,
            status: 'fallback-hash',
            message: resolution.message,
        },
        dimensions() { return hash.dimensions },
        async embed(text: string) { return hash.embed(text) },
    }
}

export { HashEmbeddingAdapter }
