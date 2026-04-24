// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL-D Compressor: SCL-S Graphs → MindsetObject
 *
 * Phase 1: structural analysis only (no LLM calls).
 * Clusters graphs by tool usage patterns and task types,
 * then extracts transformation rules from structural overlap.
 */

import { randomUUID } from 'node:crypto'
import pino from 'pino'
import type { SclSGraph } from './extractor.js'
import type { MindsetObject, MindsetRegion, ConceptAttractor, TransformationRule } from './types.js'

const logger = pino({ name: 'scl:compressor' })

/**
 * Compress a batch of SCL-S graphs into a MindsetObject.
 * Pure structural analysis — no LLM or embedding calls.
 */
export function compressToMindsetObject(
    graphs: SclSGraph[],
    workspaceId: string,
): MindsetObject {
    if (graphs.length === 0) {
        return emptyMindset(workspaceId)
    }

    // Group graphs by domain region
    const byRegion = new Map<string, SclSGraph[]>()
    for (const g of graphs) {
        const key = g.domainRegion || 'unknown'
        const existing = byRegion.get(key) ?? []
        existing.push(g)
        byRegion.set(key, existing)
    }

    // Build regions
    const regions: MindsetRegion[] = []
    const attractors: ConceptAttractor[] = []

    for (const [regionName, regionGraphs] of byRegion) {
        const toolFreq = new Map<string, number>()
        const typeFreq = new Map<string, number>()
        let qualitySum = 0
        let qualityCount = 0

        for (const g of regionGraphs) {
            for (const t of g.toolsUsed) {
                toolFreq.set(t, (toolFreq.get(t) ?? 0) + 1)
            }
            typeFreq.set(g.taskType, (typeFreq.get(g.taskType) ?? 0) + 1)
            if (g.quality != null) {
                qualitySum += g.quality
                qualityCount++
            }
        }

        const topTools = [...toolFreq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([t]) => t)

        const topTypes = [...typeFreq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([t]) => t)

        const regionId = randomUUID()
        regions.push({
            id: regionId,
            name: regionName,
            taskCount: regionGraphs.length,
            avgQuality: qualityCount > 0 ? qualitySum / qualityCount : 0,
            topTools,
            topTaskTypes: topTypes,
            children: [],
        })

        // Create attractors for top tools
        for (const [tool, freq] of toolFreq.entries()) {
            attractors.push({
                id: randomUUID(),
                region: regionId,
                type: 'tool-pattern',
                label: tool,
                salience: freq / regionGraphs.length,
                frequency: freq,
            })
        }

        // Create attractors for task types
        for (const [type, freq] of typeFreq.entries()) {
            attractors.push({
                id: randomUUID(),
                region: regionId,
                type: 'task-type',
                label: type,
                salience: freq / regionGraphs.length,
                frequency: freq,
            })
        }
    }

    // Build transformation rules (cross-region tool overlap)
    const transformations: TransformationRule[] = []
    const regionList = [...byRegion.entries()]

    for (let i = 0; i < regionList.length; i++) {
        for (let j = i + 1; j < regionList.length; j++) {
            const entryA = regionList[i]!
            const entryB = regionList[j]!
            const [nameA, graphsA] = entryA
            const [nameB, graphsB] = entryB

            const toolsA = new Set(graphsA.flatMap((g: SclSGraph) => g.toolsUsed))
            const toolsB = new Set(graphsB.flatMap((g: SclSGraph) => g.toolsUsed))
            const shared: string[] = [...toolsA].filter(t => toolsB.has(t))

            if (shared.length > 0) {
                const union = new Set([...toolsA, ...toolsB])
                transformations.push({
                    sourceRegion: nameA,
                    targetRegion: nameB,
                    relationType: 'shares-tools',
                    confidence: shared.length / union.size,
                    sharedTools: shared,
                })
            }
        }
    }

    const now = new Date().toISOString()
    return {
        version: 'scl/0.2',
        workspaceId,
        regions,
        attractors,
        transformations,
        confidence: graphs.length >= 50 ? 0.8 : graphs.length / 50 * 0.8,
        taskCount: graphs.length,
        createdAt: now,
        updatedAt: now,
    }
}

function emptyMindset(workspaceId: string): MindsetObject {
    const now = new Date().toISOString()
    return {
        version: 'scl/0.2',
        workspaceId,
        regions: [],
        attractors: [],
        transformations: [],
        confidence: 0,
        taskCount: 0,
        createdAt: now,
        updatedAt: now,
    }
}

/**
 * Merge new graphs into an existing MindsetObject.
 * Recompresses from scratch with all available graphs.
 */
export function mergeMindsetObject(
    existing: MindsetObject,
    newGraphs: SclSGraph[],
): MindsetObject {
    // For now, recompress — incremental merge is a future optimization
    return compressToMindsetObject(newGraphs, existing.workspaceId)
}
