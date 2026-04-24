// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Region splitting via k-means (k=2) on attractor position vectors.
 *
 * When a region accumulates more attractors than the split threshold,
 * it's bisected into two child regions. This keeps expand() efficient
 * by narrowing the region-boost search space.
 */

import type { GoldenRecord, DomainRegion } from './types.js'
import { cosineSimilarity, centroid } from './utils/vector.js'
import { generateId } from './utils/id.js'

/** Default: split any region with more than 8 attractors. */
export const SPLIT_THRESHOLD = 8

/** Max k-means iterations per split. */
const MAX_ITERATIONS = 10

/**
 * Cosine distance: 1 - cosineSimilarity.
 */
function cosineDistance(a: number[], b: number[]): number {
    return 1 - cosineSimilarity(a, b)
}

/**
 * Split a single region into two children using k-means (k=2).
 *
 * If the region has fewer attractors than `threshold`, returns the
 * record unchanged. The parent region keeps its id but gains two
 * children; attractors are reassigned to the closer child.
 */
export function splitRegion(
    record: GoldenRecord,
    regionId: string,
    threshold: number = SPLIT_THRESHOLD,
): GoldenRecord {
    const region = record.regions.find(r => r.id === regionId)
    if (!region) return record

    const regionAttractors = record.attractors.filter(a => a.regionId === regionId)
    if (regionAttractors.length <= threshold) return record

    // Initialize two centroids: pick the two most distant attractors
    let maxDist = -1
    let initA = 0
    let initB = 1
    for (let i = 0; i < regionAttractors.length; i++) {
        for (let j = i + 1; j < regionAttractors.length; j++) {
            const d = cosineDistance(regionAttractors[i]!.position, regionAttractors[j]!.position)
            if (d > maxDist) {
                maxDist = d
                initA = i
                initB = j
            }
        }
    }

    let c0 = [...regionAttractors[initA]!.position]
    let c1 = [...regionAttractors[initB]!.position]

    // K-means iterations
    let assignments = new Array<0 | 1>(regionAttractors.length).fill(0)
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const newAssignments: (0 | 1)[] = []
        for (const a of regionAttractors) {
            const d0 = cosineDistance(a.position, c0)
            const d1 = cosineDistance(a.position, c1)
            newAssignments.push(d0 <= d1 ? 0 : 1)
        }

        // Check convergence
        const converged = newAssignments.every((v, i) => v === assignments[i])
        assignments = newAssignments

        // Recompute centroids
        const cluster0 = regionAttractors.filter((_, i) => assignments[i] === 0)
        const cluster1 = regionAttractors.filter((_, i) => assignments[i] === 1)

        if (cluster0.length > 0) c0 = centroid(cluster0.map(a => a.position))
        if (cluster1.length > 0) c1 = centroid(cluster1.map(a => a.position))

        if (converged) break
    }

    // Guard: if one cluster is empty, don't split (all attractors identical direction)
    const cluster0 = regionAttractors.filter((_, i) => assignments[i] === 0)
    const cluster1 = regionAttractors.filter((_, i) => assignments[i] === 1)
    if (cluster0.length === 0 || cluster1.length === 0) return record

    // Create child regions
    const child0: DomainRegion = {
        id: generateId(),
        label: `${region.label}:0`,
        centroid: c0,
        radius: 1.0,
        density: cluster0.length,
        children: [],
        namespace: region.namespace,
    }
    const child1: DomainRegion = {
        id: generateId(),
        label: `${region.label}:1`,
        centroid: c1,
        radius: 1.0,
        density: cluster1.length,
        children: [],
        namespace: region.namespace,
    }

    // Reassign attractors
    for (const a of cluster0) a.regionId = child0.id
    for (const a of cluster1) a.regionId = child1.id

    // Update parent
    region.children.push(child0.id, child1.id)

    // Add child regions to record
    record.regions.push(child0, child1)

    return record
}

/**
 * Check ALL regions and split any that exceed the threshold.
 * Processes regions snapshot to avoid infinite loops from newly created children.
 */
export function autoSplit(
    record: GoldenRecord,
    threshold: number = SPLIT_THRESHOLD,
): GoldenRecord {
    // Snapshot current region IDs — don't iterate children we just created
    const regionIds = record.regions.map(r => r.id)
    for (const id of regionIds) {
        splitRegion(record, id, threshold)
    }
    return record
}
