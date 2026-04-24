// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type {
    GoldenRecord, MutationInput, MutationResult,
    ConceptAttractor, LedgerPointer, DriftWarning, TransformationRule,
} from './types.js'
import type { SCLConfig } from './config.js'
import { resolveConfig } from './config.js'
import { cosineSimilarity, weightedAverage, centroid } from './utils/vector.js'
import { generateId } from './utils/id.js'
import { checkPromotions } from './promote.js'
import { splitRegion } from './split.js'

interface NearestMatch {
    attractor: ConceptAttractor
    distance: number
}

function findNearest(record: GoldenRecord, position: number[]): NearestMatch | null {
    if (record.attractors.length === 0) return null

    let best: NearestMatch | null = null
    for (const attractor of record.attractors) {
        const sim = cosineSimilarity(attractor.position, position)
        // Convert similarity to distance: distance = 1 - similarity
        const distance = 1 - sim
        if (!best || distance < best.distance) {
            best = { attractor, distance }
        }
    }
    return best
}

function findRegionForPosition(record: GoldenRecord, position: number[]): string {
    if (record.regions.length === 0) return ''

    let bestRegion = record.regions[0]!
    let bestSim = -Infinity

    for (const region of record.regions) {
        const sim = cosineSimilarity(region.centroid, position)
        if (sim > bestSim) {
            bestSim = sim
            bestRegion = region
        }
    }

    return bestRegion.id
}

export class EmbeddingDimensionMismatchError extends Error {
    constructor(
        public readonly expected: number,
        public readonly received: number,
        public readonly provider?: string,
    ) {
        super(
            `Embedding dimension mismatch: Golden Record has ${expected}-dim vectors`
            + ` but incoming concept has ${received}-dim. Provider change requires re-embedding.`
        )
        this.name = 'EmbeddingDimensionMismatchError'
    }
}

export function mutate(
    record: GoldenRecord,
    input: MutationInput,
    configOverride?: Partial<SCLConfig>,
): MutationResult {
    const config = resolveConfig(configOverride)
    const now = Date.now()

    // Embedding consistency guard: reject mutation if incoming vectors have
    // different dimensionality than the Golden Record's existing attractors.
    // Comparing vectors from different embedding providers/dimensions produces
    // meaningless cosine similarity — silent data corruption.
    //
    // Falls back to record.embeddingDimensions when the attractor list is empty
    // (e.g., a workspace that was booted with OpenAI 1536-dim then had all
    // mechanics pruned). Without this fallback, a re-boot with a different provider
    // could silently introduce incompatible vectors.
    if (input.concepts.length > 0) {
        const referenceDim = record.attractors.length > 0
            ? record.attractors[0]!.position.length
            : record.embeddingDimensions

        if (referenceDim !== undefined) {
            for (const concept of input.concepts) {
                if (concept.position.length !== referenceDim) {
                    throw new EmbeddingDimensionMismatchError(
                        referenceDim,
                        concept.position.length,
                        record.embeddingProvider,
                    )
                }
            }
        }
    }

    let attractorsRefined = 0
    let attractorsCreated = 0
    const ghostsArchived: LedgerPointer[] = []
    const driftWarnings: DriftWarning[] = []
    let rulesAdded = 0
    let rulesRefined = 0

    // Regions whose attractors changed (created, refined, or ghosted) — need centroid refresh.
    const affectedRegionIds = new Set<string>()

    // Map from input label to attractor ID (for relation linking)
    const labelToId = new Map<string, string>()

    // Pre-populate with existing attractors
    for (const a of record.attractors) {
        labelToId.set(a.label, a.id)
    }

    for (const concept of input.concepts) {
        const nearest = findNearest(record, concept.position)

        if (nearest && nearest.distance < config.refinementThreshold) {
            // This is a refinement of an existing attractor

            // Drift check: if refining a drift-protected attractor
            if (nearest.attractor.driftProtected && nearest.distance > config.spiritDriftThreshold) {
                driftWarnings.push({
                    attractorId: nearest.attractor.id,
                    attractorLabel: nearest.attractor.label,
                    currentPosition: [...nearest.attractor.position],
                    proposedPosition: [...concept.position],
                    semanticDistance: nearest.distance,
                    threshold: config.spiritDriftThreshold,
                    source: input.source,
                    status: 'pending',
                    createdAt: now,
                })
                labelToId.set(concept.label, nearest.attractor.id)
                continue // Do NOT apply mutation
            }

            // Apply refinement with adaptive incoming weight.
            // Robbins-Monro schedule: incoming ∝ 1/sqrt(n+1) ensures convergence —
            // established attractors stabilize while new ones adapt quickly.
            // At mutationCount=0 the weight equals the configured default (0.3/√1 = 0.3),
            // so the first mutation is unaffected and existing tests remain valid.
            const adaptiveIncoming = config.refinementWeightIncoming / Math.sqrt(nearest.attractor.mutationCount + 1)
            const adaptiveExisting = 1 - adaptiveIncoming
            nearest.attractor.position = weightedAverage(
                nearest.attractor.position,
                concept.position,
                adaptiveExisting,
                adaptiveIncoming,
            )
            nearest.attractor.mutationCount++
            nearest.attractor.lastMutatedAt = now
            if (concept.attributes) {
                nearest.attractor.attributes = {
                    ...nearest.attractor.attributes,
                    ...concept.attributes,
                }
            }
            attractorsRefined++
            affectedRegionIds.add(nearest.attractor.regionId)
            labelToId.set(concept.label, nearest.attractor.id)
        } else {
            // New concept — create new attractor
            const newId = generateId()
            const regionId = findRegionForPosition(record, concept.position)
            const newAttractor: ConceptAttractor = {
                id: newId,
                position: concept.position,
                regionId,
                type: concept.type,
                depthClass: 'mechanics',
                salience: 0.5,
                driftProtected: false,
                label: concept.label,
                mutationCount: 0,
                lastMutatedAt: now,
                attributes: concept.attributes,
            }
            record.attractors.push(newAttractor)
            attractorsCreated++
            affectedRegionIds.add(regionId)
            labelToId.set(concept.label, newId)
        }

        // Ghost check: any mechanics attractor very close to this concept's
        // position (but not the one just refined or created) is being superseded
        const justProcessedId = labelToId.get(concept.label)
        const ghostCandidates = record.attractors.filter(a =>
            a.id !== justProcessedId &&
            a.depthClass === 'mechanics' &&
            !a.driftProtected
        )
        for (const candidate of ghostCandidates) {
            const dist = 1 - cosineSimilarity(candidate.position, concept.position)
            if (dist < config.ghostDisplacementThreshold) {
                const pointer: LedgerPointer = {
                    externalRef: generateId(),
                    ghostLabel: candidate.label,
                    archivedAt: now,
                    displacedBy: concept.label,
                    positionAtArchival: [...candidate.position],
                }
                ghostsArchived.push(pointer)
                record.ledgerRefs.push(pointer)
                affectedRegionIds.add(candidate.regionId)
                record.attractors = record.attractors.filter(a => a.id !== candidate.id)
            }
        }
    }

    // Process relations → transformation rules
    for (const rel of input.relations) {
        const sourceId = labelToId.get(rel.sourceLabel)
        const targetId = labelToId.get(rel.targetLabel)
        if (!sourceId || !targetId) continue

        const sourceAttractor = record.attractors.find(a => a.id === sourceId)
        const targetAttractor = record.attractors.find(a => a.id === targetId)
        if (!sourceAttractor || !targetAttractor) continue

        // Check for existing rule between these regions with same relation type
        const existing = record.transformations.find(t =>
            t.sourceRegionId === sourceAttractor.regionId &&
            t.targetRegionId === targetAttractor.regionId &&
            t.relationType === rel.relation
        )

        if (existing) {
            // Refine: update confidence
            existing.confidence = existing.confidence * 0.7 + rel.confidence * 0.3
            rulesRefined++
        } else {
            // Create new rule
            const transform = sourceAttractor.position.map((v, i) =>
                (targetAttractor.position[i] ?? 0) - v
            )
            const rule: TransformationRule = {
                id: generateId(),
                sourceRegionId: sourceAttractor.regionId,
                targetRegionId: targetAttractor.regionId,
                relationType: rel.relation,
                transform,
                modality: 'factual',
                confidence: rel.confidence,
                depthClass: 'mechanics',
            }
            record.transformations.push(rule)
            rulesAdded++
        }
    }

    // Promotion check
    checkPromotions(record, config)

    // Auto-split only the regions that were actually modified this mutation.
    // Calling autoSplit(record) here would scan ALL regions × ALL attractors
    // on every mutation, producing O(n·m) work per call and O(k·n·m) total
    // for k-mutation pressure tests — which causes the test suite to hang.
    for (const regionId of affectedRegionIds) {
        splitRegion(record, regionId)
    }

    record.lastMutatedAt = now

    // Refresh centroid and density for every region that had attractors added,
    // refined, or ghosted. Accurate centroids are required for the cluster-hypothesis
    // region-boost in expand() ranking (0.15 * regionSim term). Without this, a
    // workspace that accumulates hundreds of mechanics keeps a boot-time centroid
    // computed from only the initial spirit anchors.
    for (const regionId of affectedRegionIds) {
        const region = record.regions.find(r => r.id === regionId)
        if (!region) continue
        const regionAttractors = record.attractors.filter(a => a.regionId === regionId)
        region.density = regionAttractors.length
        if (regionAttractors.length > 0) {
            region.centroid = centroid(regionAttractors.map(a => a.position))
        }
    }

    return {
        attractorsRefined,
        attractorsCreated,
        ghostsArchived,
        driftWarnings,
        rulesAdded,
        rulesRefined,
    }
}
