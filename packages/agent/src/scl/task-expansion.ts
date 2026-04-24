// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL task expansion: encode task stimulus and expand Golden Record
 * for agent context injection.
 *
 * Replaces the old MindsetObject expansion in agent-loop.ts.
 * Uses real embeddings for accurate semantic matching.
 */

import { expand, cosineSimilarity } from '@plexo/scl-core'
import type { ResolutionLevel, ExpandedNode } from '@plexo/scl-core'

// Mirror expand.ts token estimates — used for budget arithmetic in expandForTask.
const TOKENS_PER_L0 = 10
const TOKENS_PER_L1 = 50
// Approximate tokens for one rendered edge line ("  src —[RELATION]→ tgt") and
// the fixed overhead of the context block header/footer and relationships header.
// These are not in the expand() budget and were previously undercounted.
const TOKENS_PER_EDGE = 8
const CONTEXT_BLOCK_OVERHEAD = 30

// MMR config:
//   λ=0.7: first pick = pure relevance (maxRedundancy=0); later picks balance
//   relevance against similarity to already-selected nodes.
//   POOL_FACTOR=3: request 3× candidates so MMR has real diversity to choose from
//   without O(N²) explosion (MMR is O(pool × budget) at these sizes).
const MMR_LAMBDA = 0.7
const MMR_POOL_FACTOR = 3

// Minimum cosine similarity for a mechanics attractor to enter the MMR candidate
// pool. Near-orthogonal concepts (< 0.05 cosine) are semantically unrelated to the
// task — including them wastes context budget and adds noise.
// Theory: dense retrieval score thresholds (Karpukhin et al., 2020 DPR; Xiong et al.,
// 2021 ANCE). Spirit nodes are exempt — they're pinned separately regardless.
const MIN_MECHANICS_RELEVANCE = 0.05

/**
 * Maximal Marginal Relevance reranking — Carbonell & Goldstein (1998).
 *
 * Selects `maxNodes` from `candidates` by greedily maximizing:
 *   λ·relevance − (1−λ)·max_cosine_sim_to_already_selected
 *
 * Prevents near-duplicate attractors (cosine dist 0.10–0.40) from consuming
 * the context budget. The ghost mechanism already removes very-close duplicates
 * (dist < 0.10), but moderately similar mechanics commonly coexist.
 *
 * When candidates.length ≤ maxNodes, returns candidates unchanged — every
 * candidate fits in budget, no reranking needed.
 */
export function mmrRerank(
    candidates: ExpandedNode[],
    positionMap: Map<string, number[]>,
    maxNodes: number,
    lambda = MMR_LAMBDA,
): ExpandedNode[] {
    if (candidates.length <= maxNodes) return candidates

    const selected: ExpandedNode[] = []
    const pool = [...candidates]

    while (selected.length < maxNodes && pool.length > 0) {
        let bestScore = -Infinity
        let bestIdx = 0

        for (let i = 0; i < pool.length; i++) {
            const node = pool[i]!
            const pos = positionMap.get(node.id)

            let maxRedundancy = 0
            if (pos && selected.length > 0) {
                for (const sel of selected) {
                    const selPos = positionMap.get(sel.id)
                    if (!selPos) continue
                    const sim = cosineSimilarity(pos, selPos)
                    if (sim > maxRedundancy) maxRedundancy = sim
                }
            }

            const score = lambda * node.relevance - (1 - lambda) * maxRedundancy
            if (score > bestScore) {
                bestScore = score
                bestIdx = i
            }
        }

        selected.push(pool[bestIdx]!)
        pool.splice(bestIdx, 1)
    }

    return selected
}
import { loadGoldenRecord, saveGoldenRecord, isSclEnabled } from './storage.js'
import pino from 'pino'

const logger = pino({ name: 'scl:task-expansion' })

export interface TaskExpansionResult {
    /** Formatted context block for system prompt injection */
    contextBlock: string
    /** Token count of the expansion */
    tokenCount: number
    /** Regions activated (for experience loop tracking) */
    regionsActivated: string[]
    /** Attractor IDs activated (for salience feedback) */
    attractorIds: string[]
    /** Number of attractors expanded */
    attractorsExpanded: number
}

/**
 * Expand the Golden Record for a task context.
 *
 * @param workspaceId - workspace to expand from
 * @param taskDescription - task description for stimulus encoding
 * @param embeddingProvider - embedding provider for stimulus encoding
 * @param level - resolution level (L0/L1/L2), default L1
 * @param contextBudget - max tokens for expansion, default 2000
 */
export async function expandForTask(
    workspaceId: string,
    taskDescription: string,
    embeddingProvider: { embed(text: string): Promise<number[]> },
    level: ResolutionLevel = 'L1',
    contextBudget = 2000,
): Promise<TaskExpansionResult | null> {
    if (!(await isSclEnabled(workspaceId))) return null

    const record = await loadGoldenRecord(workspaceId)
    if (!record || record.attractors.length === 0) return null

    // Encode stimulus with real embeddings
    let stimulus: number[]
    try {
        stimulus = await embeddingProvider.embed(taskDescription.slice(0, 2000))
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to encode task stimulus — skipping SCL expansion')
        return null
    }

    const tokensPerNode = level === 'L0' ? TOKENS_PER_L0 : TOKENS_PER_L1
    const isL2 = level === 'L2'

    // For L0/L1: expand a 3× candidate pool then MMR-select to the actual budget,
    // ensuring diversity without redundant near-duplicate mechanics consuming slots.
    // For L2: return all attractors as-is — MMR over the full record is not useful.
    const poolBudget = isL2 ? contextBudget : contextBudget * MMR_POOL_FACTOR

    const poolResult = expand(record, {
        stimulus,
        level,
        contextBudget: poolBudget,
        priority: 'relevance',
    })

    if (poolResult.nodes.length === 0) return null

    let selectedNodes: ExpandedNode[]
    let regionsActivated: string[]

    if (isL2) {
        selectedNodes = poolResult.nodes
        regionsActivated = poolResult.regionsActivated
    } else {
        const positionMap = new Map<string, number[]>(
            record.attractors.map(a => [a.id, a.position])
        )
        const maxNodes = Math.floor(contextBudget / tokensPerNode)

        // Spirit anchors define agent identity and are mandatory context — they must
        // always appear regardless of per-task relevance. Pin them unconditionally,
        // then MMR-diversify only among mechanics candidates for remaining slots.
        // This is the "forced inclusion" pattern from constrained retrieval: mandatory
        // items are selected first, the diversity budget applies only to the remainder.
        //
        // Guarantee: expand() truncates the pool at poolBudget. In a mature workspace
        // with 120+ highly-relevant mechanics, spirit anchors (salience=1.0, lower
        // directSim for domain tasks) can fall below the pool cutoff. Fetch them
        // directly from record.attractors so pinning is deterministic, not statistical.
        const poolSpiritIds = new Set(poolResult.nodes.filter(n => n.depthClass === 'spirit').map(n => n.id))
        const spiritNodes: typeof poolResult.nodes = [
            ...poolResult.nodes.filter(n => n.depthClass === 'spirit'),
            ...record.attractors
                .filter(a => a.depthClass === 'spirit' && !poolSpiritIds.has(a.id))
                .map(a => ({
                    id: a.id,
                    label: a.label,
                    type: a.type,
                    depthClass: a.depthClass,
                    relevance: cosineSimilarity(a.position, stimulus),
                })),
        ]

        // Apply minimum relevance threshold to mechanics pool — near-orthogonal
        // concepts (< 0.05 cosine) are semantically unrelated to the task.
        // Without this, a sparse workspace fills context budget with noise.
        const mechanicsNodes = poolResult.nodes.filter(
            n => n.depthClass !== 'spirit' && n.relevance >= MIN_MECHANICS_RELEVANCE
        )
        const mechanicsSlots = Math.max(0, maxNodes - spiritNodes.length)
        const selectedMechanics = mmrRerank(mechanicsNodes, positionMap, mechanicsSlots)
        selectedNodes = [...spiritNodes, ...selectedMechanics]

        // Recompute activated regions from the final selected node set
        const attractorRegionMap = new Map<string, string>(
            record.attractors.map(a => [a.id, a.regionId])
        )
        const regionIdSet = new Set<string>()
        for (const node of selectedNodes) {
            const rId = attractorRegionMap.get(node.id)
            if (rId) regionIdSet.add(rId)
        }
        regionsActivated = [...regionIdSet]
    }

    // Format context block.
    // Spirit anchors are sorted first so the agent always sees its core identity
    // before task-specific learned mechanics. Within each depth class the
    // MMR order (diversity-aware relevance) is preserved.
    const lines: string[] = []
    lines.push(`=== WORKSPACE MEMORY (SCL Golden Record, ${selectedNodes.length}/${poolResult.totalAttractors} concepts) ===`)

    const orderedNodes = [...selectedNodes].sort((a, b) => {
        if (a.depthClass === b.depthClass) return 0
        return a.depthClass === 'spirit' ? -1 : 1
    })
    for (const node of orderedNodes) {
        const marker = node.depthClass === 'spirit' ? '[CORE]' : ''
        // Spirit nodes show "always active" rather than a raw relevance score.
        // A spirit anchor for "I am Plexo" scoring 3% on a "generate invoice" task
        // does not mean identity is 3% important — it's pinned unconditionally.
        // Showing a misleading low % could cause the agent to underweight its identity.
        const relevanceLabel = node.depthClass === 'spirit'
            ? 'always active'
            : `relevance: ${(node.relevance * 100).toFixed(0)}%`
        lines.push(`• ${node.label} ${marker} (${relevanceLabel})`)
    }

    if (poolResult.edges.length > 0) {
        lines.push('')
        lines.push('Relationships:')
        for (const edge of poolResult.edges) {
            const src = selectedNodes.find(n => n.id === edge.source)
            const tgt = selectedNodes.find(n => n.id === edge.target)
            if (src && tgt) {
                lines.push(`  ${src.label} —[${edge.relation}]→ ${tgt.label}`)
            }
        }
    }

    lines.push(`=== END WORKSPACE MEMORY ===`)

    // Count edges that are actually rendered (both endpoints in selectedNodes).
    // Edge lines and the context block header/footer were previously excluded from
    // the declared tokenCount, undercounting by up to ~400 tokens.
    const selectedIdSet = new Set(selectedNodes.map(n => n.id))
    const renderedEdgeCount = poolResult.edges.filter(
        e => selectedIdSet.has(e.source) && selectedIdSet.has(e.target)
    ).length
    const finalBudget = isL2
        ? poolResult.budgetUsed
        : selectedNodes.length * tokensPerNode + renderedEdgeCount * TOKENS_PER_EDGE + CONTEXT_BLOCK_OVERHEAD
    return {
        contextBlock: lines.join('\n'),
        tokenCount: finalBudget,
        regionsActivated,
        attractorIds: selectedNodes.map(n => n.id),
        attractorsExpanded: selectedNodes.length,
    }
}

/**
 * Experience loop: update attractor salience based on task outcome.
 *
 * @param workspaceId - workspace
 * @param attractorIds - IDs of attractors that were activated during expansion
 * @param accepted - true if task succeeded (quality >= 0.7), false if failed
 */
export async function updateSalience(
    workspaceId: string,
    attractorIds: string[],
    accepted: boolean,
): Promise<void> {
    if (attractorIds.length === 0) return

    const record = await loadGoldenRecord(workspaceId)
    if (!record) return

    const delta = accepted ? 0.05 : -0.05
    const activatedSet = new Set(attractorIds)

    let changed = false
    for (const attractor of record.attractors) {
        if (activatedSet.has(attractor.id)) {
            attractor.salience = Math.max(0.1, Math.min(1.0, attractor.salience + delta))
            changed = true
        }
    }

    if (changed) {
        await saveGoldenRecord(workspaceId, record)
        logger.info({
            workspaceId,
            count: attractorIds.length,
            direction: accepted ? 'up' : 'down',
            delta,
        }, 'SCL salience updated from experience loop')
    }
}
