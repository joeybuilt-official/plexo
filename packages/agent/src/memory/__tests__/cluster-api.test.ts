// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tests for the generic memory.cluster API.
 *
 * - Empty input → empty result
 * - kmeans on synthetic 2-mode data clusters into 2 groups
 * - agglomerative respects threshold + minClusterSize
 * - hdbscan throws METHOD_NOT_IMPLEMENTED (the seam, not the algo)
 * - topicLabel: empty input shortcut + c-TF-IDF fallback when LLM unavailable
 */
import { describe, it, expect } from 'vitest'
import { cluster, topicLabel } from '../cluster-api.js'

/** Build vectors that fall into two well-separated 2-D regions, padded to 8d. */
function makePoint(group: 'a' | 'b', noise = 0): number[] {
    const base = group === 'a' ? [1, 0, 0.5, 0.2, 0.1, 0.1, 0, 0] : [-1, 0, -0.4, -0.1, 0.1, 0.1, 0, 0]
    return base.map(v => v + (Math.random() - 0.5) * noise)
}

describe('cluster()', () => {
    it('returns an empty result for empty input (no edge case explosions)', async () => {
        const r = await cluster([])
        expect(r.assignments).toEqual([])
        expect(r.clusters).toEqual([])
        expect(r.noise).toEqual([])
        expect(r.method).toBe('kmeans')
    })

    it('kmeans with k=2 separates two well-defined groups', async () => {
        const items = [
            { id: 'a1', vector: makePoint('a') },
            { id: 'a2', vector: makePoint('a') },
            { id: 'a3', vector: makePoint('a') },
            { id: 'a4', vector: makePoint('a') },
            { id: 'b1', vector: makePoint('b') },
            { id: 'b2', vector: makePoint('b') },
            { id: 'b3', vector: makePoint('b') },
            { id: 'b4', vector: makePoint('b') },
        ]
        const r = await cluster(items, { method: 'kmeans', k: 2 })
        expect(r.clusters.length).toBe(2)
        expect(r.assignments).toHaveLength(8)
        const aCluster = r.assignments.find(x => x.id === 'a1')!.clusterId
        for (const id of ['a2', 'a3', 'a4']) {
            expect(r.assignments.find(x => x.id === id)!.clusterId).toBe(aCluster)
        }
        const bCluster = r.assignments.find(x => x.id === 'b1')!.clusterId
        expect(bCluster).not.toBe(aCluster)
    })

    it('kmeans auto-picks k when omitted', async () => {
        const items = Array.from({ length: 6 }, (_, i) => ({ id: `${i}`, vector: makePoint(i < 3 ? 'a' : 'b') }))
        const r = await cluster(items, { method: 'kmeans' })
        expect(r.chosenK).toBeGreaterThanOrEqual(2)
        expect(r.clusters.length).toBeGreaterThan(0)
    })

    it('agglomerative groups by cosine threshold and respects minClusterSize', async () => {
        const items = [
            { id: 'a1', vector: [1, 0, 0, 0] },
            { id: 'a2', vector: [0.99, 0.01, 0, 0] },
            { id: 'a3', vector: [0.98, 0.02, 0, 0] },
            { id: 'b1', vector: [-1, 0, 0, 0] },
            { id: 'lone', vector: [0, 1, 0, 0] },
        ]
        const r = await cluster(items, {
            method: 'agglomerative',
            distanceThreshold: 0.05,
            minClusterSize: 2,
        })
        // The 'a' group survives, the singletons go to noise.
        expect(r.noise).toContain('lone')
        expect(r.noise).toContain('b1')
        const a1 = r.assignments.find(x => x.id === 'a1')!.clusterId
        expect(a1).toBeGreaterThanOrEqual(0)
        expect(r.assignments.find(x => x.id === 'a2')!.clusterId).toBe(a1)
        expect(r.assignments.find(x => x.id === 'a3')!.clusterId).toBe(a1)
    })

    it('hdbscan is a reserved seam — throws until implemented', async () => {
        await expect(cluster([{ id: 'x', vector: [1, 0] }], { method: 'hdbscan' }))
            .rejects.toThrow(/not yet implemented/)
    })
})

describe('topicLabel()', () => {
    it('returns a placeholder for empty input', async () => {
        const r = await topicLabel({ contents: [] })
        expect(r.label).toBe('Empty cluster')
        expect(r.source).toBe('ctfidf')
    })

    it('falls back to c-TF-IDF when no LLM provider is configured', async () => {
        // No PROVIDER_* env vars in test → resolveModelFromEnv throws → fallback.
        const r = await topicLabel({
            contents: [
                'Quarterly budget review for marketing department',
                'Marketing budget reconciliation Q3',
                'Reviewing marketing department spend year-over-year',
            ],
        })
        expect(r.source).toBe('ctfidf')
        expect(r.label.length).toBeGreaterThan(0)
    })
})
