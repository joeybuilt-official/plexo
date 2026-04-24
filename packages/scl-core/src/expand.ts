// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type {
    GoldenRecord, ExpandRequest, ExpansionResult,
    ExpandedNode, ExpandedEdge, ConceptAttractor,
} from './types.js'
import { cosineSimilarity } from './utils/vector.js'

const TOKENS_PER_L0 = 10
const TOKENS_PER_L1 = 50
// Caps edge output regardless of how many attractor-pair combinations a
// region-to-region rule produces. With a single root region, every rule fans
// out to O(N²) pairs; without this cap, a 40-node L1 expansion with 10 rules
// produces ~15 000 edge lines in the context block.
const MAX_EDGES = 20

export function expand(record: GoldenRecord, request: ExpandRequest): ExpansionResult {
    if (record.attractors.length === 0) {
        return emptyResult(0)
    }

    // Stimulus dimension guard: a mismatched stimulus produces silent zero cosine
    // similarities for every attractor — the stimulus effectively stops influencing
    // ranking and all attractors sort purely by salience/region, not relevance.
    // Return empty rather than a valid-looking but stimulus-blind expansion.
    // (Write-time equivalent: EmbeddingDimensionMismatchError in mutate.ts.)
    if (request.stimulus.length !== record.attractors[0]!.position.length) {
        return emptyResult(record.attractors.length)
    }

    // Rank regions by cosine similarity to stimulus, retaining per-region sim
    // for the cluster-hypothesis boost applied during relevance sorting.
    const rankedRegions = record.regions
        .map(r => ({ region: r, sim: cosineSimilarity(r.centroid, request.stimulus) }))
        .sort((a, b) => b.sim - a.sim)

    // Index region sim for O(1) lookup during candidate scoring.
    const regionSimMap = new Map<string, number>(rankedRegions.map(({ region, sim }) => [region.id, sim]))

    // Collect attractors from all regions with their direct relevance scores
    const candidates: Array<{ attractor: ConceptAttractor; relevance: number; regionSim: number }> = []

    for (const { region } of rankedRegions) {
        const regionAttractors = record.attractors.filter(a => a.regionId === region.id)
        const rSim = regionSimMap.get(region.id) ?? 0
        for (const attractor of regionAttractors) {
            const relevance = cosineSimilarity(attractor.position, request.stimulus)
            candidates.push({ attractor, relevance, regionSim: rSim })
        }
    }

    // Sort by priority.
    // For 'relevance': combine attractor direct-sim, region-level sim (cluster hypothesis),
    // and salience (document authority prior) using 0.75/0.15/0.10 weights.
    // Salience encodes accumulated trust: spirit anchors (1.0) reflect core identity;
    // mechanics start at 0.5. Including it as a prior prevents identity anchors from
    // being displaced by a flood of task-specific mechanics with marginally higher
    // direct similarity — analogous to PageRank authority weighting in web IR.
    // The output node.relevance is still the raw direct-sim for semantic accuracy;
    // the region boost and salience only affect sort order.
    candidates.sort((a, b) => {
        if (request.priority === 'salience') {
            return b.attractor.salience - a.attractor.salience || b.relevance - a.relevance
        }
        if (request.priority === 'recency') {
            return b.attractor.lastMutatedAt - a.attractor.lastMutatedAt || b.relevance - a.relevance
        }
        // default: relevance — cluster-boosted + salience-weighted combined score
        const scoreA = 0.75 * a.relevance + 0.15 * a.regionSim + 0.10 * a.attractor.salience
        const scoreB = 0.75 * b.relevance + 0.15 * b.regionSim + 0.10 * b.attractor.salience
        return scoreB - scoreA
    })

    // Pack into budget
    const tokensPerAttractor = request.level === 'L0' ? TOKENS_PER_L0 : TOKENS_PER_L1
    const isL2 = request.level === 'L2'

    const selectedNodes: ExpandedNode[] = []
    const selectedIds = new Set<string>()
    // Populated from selected nodes only — regions that did not contribute are not "activated".
    const activatedRegionIds = new Set<string>()
    let budgetUsed = 0

    for (const { attractor, relevance } of candidates) {
        // Anti-correlated concepts (cosine < 0) are semantically opposed to the stimulus.
        // Standard IR relevance cutoff: negative-similarity results add noise, not signal.
        // Only applied in relevance-priority mode — salience/recency are intent-driven and
        // should not be gated by stimulus similarity.
        if (request.priority === 'relevance' && relevance < 0) continue

        if (!isL2 && budgetUsed + tokensPerAttractor > request.contextBudget) break

        selectedNodes.push({
            id: attractor.id,
            label: attractor.label,
            type: attractor.type,
            depthClass: attractor.depthClass,
            relevance,
            ...(request.level !== 'L0' ? { attributes: attractor.attributes } : {}),
        })
        selectedIds.add(attractor.id)
        activatedRegionIds.add(attractor.regionId)
        budgetUsed += tokensPerAttractor
    }

    // Find edges connecting selected nodes
    const edges: ExpandedEdge[] = []
    if (request.level !== 'L0') {
        const seenEdges = new Set<string>()

        // Sort by confidence descending so the MAX_EDGES budget fills from the
        // highest-evidence relationships first. Without this, insertion-order
        // iteration can exhaust the cap on low-confidence rules before high-
        // confidence ones (added later) ever run. Analogous to document scoring
        // in constrained retrieval: rank by evidence strength before truncating.
        const sortedTransformations = [...record.transformations].sort((a, b) => b.confidence - a.confidence)

        for (const rule of sortedTransformations) {
            if (edges.length >= MAX_EDGES) break

            // Match by region — find attractors in source/target regions
            const sourceAttractors = selectedNodes.filter(n => {
                const a = record.attractors.find(att => att.id === n.id)
                return a && a.regionId === rule.sourceRegionId
            })
            const targetAttractors = selectedNodes.filter(n => {
                const a = record.attractors.find(att => att.id === n.id)
                return a && a.regionId === rule.targetRegionId
            })

            outer: for (const s of sourceAttractors) {
                for (const t of targetAttractors) {
                    if (edges.length >= MAX_EDGES) break outer
                    if (s.id === t.id) continue
                    const key = `${s.id}|${t.id}|${rule.relationType}`
                    if (seenEdges.has(key)) continue
                    seenEdges.add(key)
                    edges.push({
                        source: s.id,
                        target: t.id,
                        relation: rule.relationType,
                        confidence: rule.confidence,
                    })
                }
            }
        }
    }

    return {
        nodes: selectedNodes,
        edges,
        regionsActivated: [...activatedRegionIds],
        budgetUsed,
        totalAttractors: record.attractors.length,
        attractorsExpanded: selectedNodes.length,
    }
}

function emptyResult(totalAttractors: number): ExpansionResult {
    return {
        nodes: [],
        edges: [],
        regionsActivated: [],
        budgetUsed: 0,
        totalAttractors,
        attractorsExpanded: 0,
    }
}
