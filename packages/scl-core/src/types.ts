// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// ── Enums / Unions ────────────────────────────────────────

export type DepthClass = 'spirit' | 'mechanics'
export type ResolutionLevel = 'L0' | 'L1' | 'L2'

export type ConceptType =
    | 'entity' | 'event' | 'state' | 'claim'
    | 'schema' | 'action' | 'property' | 'quantity'

export type RelationType =
    | 'IS_A' | 'HAS_PART' | 'INSTANCE_OF' | 'MEMBER_OF' | 'HAS_PROPERTY'
    | 'CAUSES' | 'ENABLES' | 'PREVENTS' | 'REQUIRES'
    | 'BEFORE' | 'AFTER' | 'DURING' | 'SIMULTANEOUS'
    | 'IMPLIES' | 'CONTRADICTS' | 'SUPPORTS' | 'QUALIFIES'
    | 'LOCATED_IN' | 'CONTAINS'
    | 'PERFORMS' | 'EXPERIENCES' | 'INTENDS' | 'BELIEVES' | 'RECEIVES'
    | 'GREATER_THAN' | 'SIMILAR_TO' | 'DIFFERS_FROM'
    | 'DERIVED_FROM' | 'APPROXIMATES'
    | 'HAS_VALUE' | 'HAS_ROLE' | 'PRODUCES' | 'CONSUMES' | 'TARGETS'

export type Modality =
    | 'factual' | 'hypothetical' | 'negated'
    | 'obligatory' | 'possible' | 'uncertain'

// ── Core Structures ───────────────────────────────────────

export interface ConceptAttractor {
    id: string
    position: number[]
    regionId: string
    type: ConceptType
    depthClass: DepthClass
    salience: number
    driftProtected: boolean
    label: string
    mutationCount: number
    lastMutatedAt: number
    /** App namespace that owns this attractor. Undefined / 'core' = globally mutable. */
    namespace?: string
    attributes?: Record<string, unknown>
}

export interface DomainRegion {
    id: string
    label: string
    centroid: number[]
    radius: number
    density: number
    children: string[]
    namespace?: string
}

export interface TransformationRule {
    id: string
    sourceRegionId: string
    targetRegionId: string
    relationType: RelationType
    transform: number[]
    modality: Modality
    confidence: number
    depthClass: DepthClass
}

export interface LedgerPointer {
    externalRef: string
    ghostLabel: string
    archivedAt: number
    displacedBy?: string
    positionAtArchival: number[]
}

export interface GoldenRecord {
    id: string
    version: 'scl/1.0'
    workspaceId: string
    regions: DomainRegion[]
    attractors: ConceptAttractor[]
    transformations: TransformationRule[]
    ledgerRefs: LedgerPointer[]
    bootedAt: number
    lastMutatedAt: number
    /** Embedding provider that generated attractor vectors (e.g., "ollama", "openai") */
    embeddingProvider?: string
    /** Embedding model used (e.g., "snowflake-arctic-embed", "text-embedding-3-small") */
    embeddingModel?: string
    /** Embedding dimensions for consistency checking */
    embeddingDimensions?: number
}

// ── Expansion ─────────────────────────────────────────────

export interface ExpandRequest {
    stimulus: number[]
    level: ResolutionLevel
    contextBudget: number
    priority: 'relevance' | 'recency' | 'salience'
}

export interface ExpandedNode {
    id: string
    label: string
    type: ConceptType
    depthClass: DepthClass
    relevance: number
    attributes?: Record<string, unknown>
}

export interface ExpandedEdge {
    source: string
    target: string
    relation: RelationType
    confidence: number
}

export interface ExpansionResult {
    nodes: ExpandedNode[]
    edges: ExpandedEdge[]
    regionsActivated: string[]
    budgetUsed: number
    totalAttractors: number
    attractorsExpanded: number
}

// ── Mutation ──────────────────────────────────────────────

export interface MutationInput {
    source: string
    concepts: {
        label: string
        type: ConceptType
        position: number[]
        attributes?: Record<string, unknown>
    }[]
    relations: {
        sourceLabel: string
        targetLabel: string
        relation: RelationType
        confidence: number
    }[]
}

export interface DriftWarning {
    attractorId: string
    attractorLabel: string
    currentPosition: number[]
    proposedPosition: number[]
    semanticDistance: number
    threshold: number
    source: string
    status: 'pending' | 'confirmed' | 'rejected'
    createdAt: number
}

export interface MutationResult {
    attractorsRefined: number
    attractorsCreated: number
    ghostsArchived: LedgerPointer[]
    driftWarnings: DriftWarning[]
    rulesAdded: number
    rulesRefined: number
}

// ── Boot ──────────────────────────────────────────────────

export interface BootConfig {
    workspaceId: string
    spiritAnchors: {
        label: string
        type: ConceptType
        position: number[]
    }[]
}

// ── Embedding Interface ───────────────────────────────────

export interface EmbeddingProvider {
    embed(text: string): Promise<number[]>
    dimensions(): number
}
