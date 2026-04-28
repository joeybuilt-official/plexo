// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL embeddings-based clustering — parallel path behind a feature flag.
 *
 * The existing `classifier.ts` is a keyword-based domain region classifier
 * (8 fixed regions, regex match). It is the only path that writes to
 * `inference_logs.domain_region` today, so we keep it intact.
 *
 * THIS module adds an embeddings-driven parallel surface that BOTH the
 * Plexo SCL `scl_concept_graphs` cluster computation AND the keyword
 * classifier can call. It does not replace classifier.ts — it lives
 * alongside, behind the `SCL_EMBEDDINGS_CLUSTERING=true` feature flag,
 * so we can A/B compare the two surfaces before promoting one.
 *
 * API:
 *   isEmbeddingsClusteringEnabled()      — read the flag
 *   clusterSclConceptGraphs(workspaceId, items) — group SCL graphs by
 *     semantic proximity using the shared memory.cluster API
 *
 * The keyword classifier stays the source-of-truth for `domain_region`
 * column writes. This module's output is meant to live in `metadata`
 * fields or comparison dashboards until parity is proven.
 */
import pino from 'pino'
import { embed } from '../memory/embeddings.js'
import { cluster, type ClusterResult } from '../memory/cluster-api.js'

const logger = pino({ name: 'scl:embeddings-cluster' })

export function isEmbeddingsClusteringEnabled(): boolean {
    return process.env.SCL_EMBEDDINGS_CLUSTERING === 'true' || process.env.SCL_EMBEDDINGS_CLUSTERING === '1'
}

export interface SclConceptGraphItem {
    /** Row id in scl_concept_graphs. */
    id: string
    /**
     * The text representation used for embedding. Typically
     * `domainRegion + taskType + toolsUsed.join(' ')` to capture the
     * structural signature without leaking content.
     */
    signature: string
}

/**
 * Cluster a batch of SCL concept-graph rows by embedding their structural
 * signature and running the shared cluster API. Returns null when the
 * feature flag is OFF — caller falls back to the keyword classifier.
 */
export async function clusterSclConceptGraphs(
    workspaceId: string,
    items: SclConceptGraphItem[],
    opts?: { method?: 'kmeans' | 'agglomerative'; minClusterSize?: number },
): Promise<ClusterResult | null> {
    if (!isEmbeddingsClusteringEnabled()) {
        logger.debug({ workspaceId }, 'SCL embeddings clustering: flag off — returning null')
        return null
    }
    if (items.length === 0) {
        return {
            assignments: [], clusters: [], noise: [],
            method: opts?.method ?? 'kmeans', chosenK: null, durationMs: 0,
        }
    }

    const signatures = items.map(i => i.signature ?? '')
    let vectors: Float32Array[]
    try {
        vectors = await embed(signatures, { workspaceId })
    } catch (err) {
        logger.warn({ err, workspaceId, n: items.length }, 'SCL embeddings cluster: embed failed — caller should fall back')
        return null
    }

    const clusterItems = items.map((it, i) => ({
        id: it.id,
        vector: vectors[i] ?? new Float32Array(0),
    }))

    const result = await cluster(clusterItems, {
        method: opts?.method ?? 'kmeans',
        minClusterSize: opts?.minClusterSize ?? 2,
    })
    logger.info({
        workspaceId,
        n: items.length,
        method: result.method,
        clusters: result.clusters.length,
        noise: result.noise.length,
    }, 'SCL embeddings clustering complete')
    return result
}
