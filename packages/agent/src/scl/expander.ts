// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL-X Expander: MindsetObject + Stimulus → ExpandedContext
 *
 * Given a MindsetObject and a task stimulus, expand only the relevant
 * regions to produce agent context. Non-matching regions stay compressed.
 *
 * Phase 1: keyword matching (no embeddings). Accurate enough for
 * tool suggestions and pattern retrieval.
 */

import pino from 'pino'
import type { MindsetObject, ExpandedContext } from './types.js'
import { classifyDomainRegion } from './classifier.js'

const logger = pino({ name: 'scl:expander' })

export interface ExpansionStimulus {
    taskDescription: string
    taskType: string
    availableTools?: string[]
}

/**
 * Expand relevant regions of a MindsetObject for a given task stimulus.
 */
export function expandMindsetObject(
    mindset: MindsetObject,
    stimulus: ExpansionStimulus,
): ExpandedContext {
    if (mindset.regions.length === 0) {
        return emptyContext()
    }

    // Classify the stimulus to find the primary domain region
    const primaryRegion = classifyDomainRegion(stimulus.taskDescription, stimulus.taskType)

    // Find matching regions
    const matchingRegions = mindset.regions.filter(r =>
        r.name === primaryRegion ||
        r.topTaskTypes.includes(stimulus.taskType)
    )

    if (matchingRegions.length === 0) {
        // Fallback: use highest-task-count region
        const sorted = [...mindset.regions].sort((a, b) => b.taskCount - a.taskCount)
        if (sorted[0]) matchingRegions.push(sorted[0])
    }

    // Extract patterns from matching regions
    const relevantPatterns: string[] = []
    const suggestedTools: string[] = []
    const sourceRegions: string[] = []

    for (const region of matchingRegions) {
        sourceRegions.push(region.name)

        // Pattern: "In {region}, tasks typically use {tools} with {quality} quality"
        if (region.topTools.length > 0) {
            relevantPatterns.push(
                `${region.name} tasks use: ${region.topTools.slice(0, 5).join(', ')} (avg quality: ${(region.avgQuality * 100).toFixed(0)}%)`
            )
        }

        // Suggest tools from matching regions
        for (const tool of region.topTools) {
            if (!suggestedTools.includes(tool)) {
                suggestedTools.push(tool)
            }
        }
    }

    // Add transformation insights
    const domainKnowledge: string[] = []
    for (const rule of mindset.transformations) {
        if (matchingRegions.some(r => r.name === rule.sourceRegion || r.name === rule.targetRegion)) {
            if (rule.sharedTools.length > 0) {
                domainKnowledge.push(
                    `${rule.sourceRegion} and ${rule.targetRegion} share tools: ${rule.sharedTools.join(', ')}`
                )
            }
        }
    }

    // Estimate token count (rough: ~4 chars per token)
    const allText = [...relevantPatterns, ...domainKnowledge].join(' ')
    const tokenCount = Math.ceil(allText.length / 4)

    return {
        relevantPatterns,
        suggestedTools: suggestedTools.slice(0, 10),
        domainKnowledge,
        tokenCount,
        sourceRegions,
    }
}

function emptyContext(): ExpandedContext {
    return {
        relevantPatterns: [],
        suggestedTools: [],
        domainKnowledge: [],
        tokenCount: 0,
        sourceRegions: [],
    }
}
