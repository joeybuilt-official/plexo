// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL type definitions — MindsetObject and supporting structures.
 *
 * MindsetObject is a fixed-size generative structure, not enumerated facts.
 * It compresses workspace task history into a navigable concept space.
 */

export interface MindsetObject {
    version: 'scl/0.2'
    workspaceId: string
    regions: MindsetRegion[]
    attractors: ConceptAttractor[]
    transformations: TransformationRule[]
    confidence: number
    taskCount: number
    createdAt: string
    updatedAt: string
}

export interface MindsetRegion {
    id: string
    name: string
    taskCount: number
    avgQuality: number
    topTools: string[]
    topTaskTypes: string[]
    children: string[]
}

export interface ConceptAttractor {
    id: string
    region: string
    type: 'tool-pattern' | 'task-type' | 'quality-cluster'
    label: string
    salience: number
    frequency: number
}

export interface TransformationRule {
    sourceRegion: string
    targetRegion: string
    relationType: 'shares-tools' | 'similar-structure' | 'sequential'
    confidence: number
    sharedTools: string[]
}

export interface ExpandedContext {
    relevantPatterns: string[]
    suggestedTools: string[]
    domainKnowledge: string[]
    tokenCount: number
    sourceRegions: string[]
}
