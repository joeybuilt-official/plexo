// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tests for SCL embeddings-based clustering, gated by the
 * SCL_EMBEDDINGS_CLUSTERING feature flag.
 *
 * - Flag off → returns null (caller uses keyword classifier)
 * - Flag on, empty input → returns empty cluster envelope
 * - Flag on, populated input → invokes the shared embed + cluster path
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../memory/embeddings.js', () => ({
    embed: vi.fn(async (texts: string[]) =>
        texts.map(t => new Float32Array([t.length, 1, 2, 3])),
    ),
}))

import { embed as embedMock } from '../../memory/embeddings.js'

import { clusterSclConceptGraphs, isEmbeddingsClusteringEnabled } from '../embeddings-cluster.js'

const ORIGINAL_FLAG = process.env.SCL_EMBEDDINGS_CLUSTERING

beforeEach(() => {
    vi.mocked(embedMock).mockClear()
})

afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.SCL_EMBEDDINGS_CLUSTERING
    else process.env.SCL_EMBEDDINGS_CLUSTERING = ORIGINAL_FLAG
})

describe('SCL embeddings-based clustering (flag-gated)', () => {
    it('returns null when the feature flag is unset (keyword path stays canonical)', async () => {
        delete process.env.SCL_EMBEDDINGS_CLUSTERING
        expect(isEmbeddingsClusteringEnabled()).toBe(false)
        const r = await clusterSclConceptGraphs('w-1', [{ id: 'g1', signature: 'code refactor' }])
        expect(r).toBeNull()
        expect(embedMock).not.toHaveBeenCalled()
    })

    it('returns an empty envelope for empty input when the flag is on', async () => {
        process.env.SCL_EMBEDDINGS_CLUSTERING = 'true'
        const r = await clusterSclConceptGraphs('w-1', [])
        expect(r).not.toBeNull()
        expect(r!.clusters).toEqual([])
        expect(r!.assignments).toEqual([])
        expect(embedMock).not.toHaveBeenCalled()
    })

    it('embeds + clusters when the flag is on and items are provided', async () => {
        process.env.SCL_EMBEDDINGS_CLUSTERING = 'true'
        const items = [
            { id: 'g1', signature: 'code refactor api typescript' },
            { id: 'g2', signature: 'code refactor api typescript v2' },
            { id: 'g3', signature: 'writing email blog draft' },
            { id: 'g4', signature: 'writing email blog draft v2' },
        ]
        const r = await clusterSclConceptGraphs('w-1', items, { method: 'kmeans', minClusterSize: 2 })
        expect(r).not.toBeNull()
        expect(embedMock).toHaveBeenCalledTimes(1)
        expect(r!.assignments).toHaveLength(4)
    })
})
