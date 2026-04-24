// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for mmrRerank — Maximal Marginal Relevance reranking.
 *
 * Theory: Carbonell & Goldstein (1998).
 * MMR(d_i) = λ·Sim(d_i, q) − (1−λ)·max_{d_j ∈ S} Sim(d_i, d_j)
 *
 * Key property: when near-duplicate attractors are in the candidate pool,
 * MMR prefers a moderately-distinct attractor with slightly lower relevance
 * over yet-another near-duplicate — making better use of the context budget.
 */

import { describe, it, expect } from 'vitest'
import { mmrRerank } from '../task-expansion.js'
import type { ExpandedNode, DepthClass } from '@plexo/scl-core'

function makeNode(id: string, label: string, relevance: number): ExpandedNode {
    return {
        id,
        label,
        type: 'action',
        depthClass: 'mechanics',
        relevance,
    }
}

function makeNodeWithDepth(id: string, label: string, relevance: number, depthClass: DepthClass): ExpandedNode {
    return { id, label, type: 'action', depthClass, relevance }
}

// 4-D test positions
//   c1 = [0, 0, 1, 0]        — stimulus axis (coding domain)
//   c2 = [0, 0.01, 1, 0]     — near-duplicate of c1, cos(c2,c1) ≈ 0.99995
//   d1 = [0.5, 0, 0.866, 0]  — distinct (cos(d1,c1) = 0.866, magnitude = 1.0)
const POS_C1 = [0, 0, 1, 0]
const POS_C2 = [0, 0.01, 1, 0]   // very close to c1
const POS_D1 = [0.5, 0, 0.866, 0] // distinct from c1; exactly normalized (0.25+0.75=1)

describe('mmrRerank: core diversity behaviour', () => {
    it('returns candidates unchanged when pool ≤ maxNodes (no reranking needed)', () => {
        const candidates = [
            makeNode('c1', 'Coding', 1.0),
            makeNode('c2', 'JS Coding', 0.99),
        ]
        const posMap = new Map([
            ['c1', POS_C1],
            ['c2', POS_C2],
        ])
        const result = mmrRerank(candidates, posMap, 5)
        expect(result).toBe(candidates) // same reference — not copied
        expect(result).toHaveLength(2)
    })

    it('returns empty when maxNodes=0', () => {
        const candidates = [makeNode('c1', 'Coding', 1.0)]
        const posMap = new Map([['c1', POS_C1]])
        expect(mmrRerank(candidates, posMap, 0)).toHaveLength(0)
    })

    it('first selected node is always the highest-relevance candidate', () => {
        // With no previously selected nodes, maxRedundancy=0 for all, so pure relevance wins.
        const candidates = [
            makeNode('c1', 'C1', 1.0),
            makeNode('c2', 'C2', 0.99),
            makeNode('d1', 'D1', 0.98),
        ]
        const posMap = new Map([
            ['c1', POS_C1],
            ['c2', POS_C2],
            ['d1', POS_D1],
        ])
        const result = mmrRerank(candidates, posMap, 2)
        expect(result[0]!.id).toBe('c1')
    })

    it('prefers a distinct attractor over a near-duplicate on the second pick', () => {
        // Verified math (λ=0.7, after c1 selected):
        //   score(c2) = 0.7×0.99 − 0.3×cos(c2,c1) ≈ 0.693 − 0.300 = 0.393
        //   score(d1) = 0.7×0.98 − 0.3×cos(d1,c1) = 0.686 − 0.260 = 0.426
        //   d1 wins (0.426 > 0.393)
        //
        // Pure relevance top-2 would be [c1, c2] — c2 selected because rel(c2)=0.99 > rel(d1)=0.98.
        // MMR top-2 should be [c1, d1] — d1 selected because it's more distinct.
        const candidates = [
            makeNode('c1', 'Python Coding',    1.00),
            makeNode('c2', 'TypeScript Coding', 0.99),
            makeNode('d1', 'DevOps Pipeline',   0.98),
        ]
        const posMap = new Map([
            ['c1', POS_C1],
            ['c2', POS_C2],  // very close to c1
            ['d1', POS_D1],  // distinct from c1
        ])
        const result = mmrRerank(candidates, posMap, 2)

        expect(result).toHaveLength(2)
        expect(result[0]!.id).toBe('c1')  // highest relevance always first
        expect(result[1]!.id).toBe('d1')  // diverse pick over near-duplicate
    })

    it('pure relevance top-2 would have selected the near-duplicate instead', () => {
        // Confirms the test premise: without MMR, c2 (higher relevance) beats d1.
        const candidates = [
            makeNode('c1', 'Python Coding',    1.00),
            makeNode('c2', 'TypeScript Coding', 0.99),
            makeNode('d1', 'DevOps Pipeline',   0.98),
        ]
        const pureTop2 = candidates.slice(0, 2)
        expect(pureTop2[1]!.id).toBe('c2')   // c2, not d1, in pure-relevance ranking
    })

    it('selects all candidates when maxNodes equals pool size', () => {
        const candidates = [
            makeNode('c1', 'C1', 1.0),
            makeNode('c2', 'C2', 0.9),
            makeNode('d1', 'D1', 0.8),
        ]
        const posMap = new Map([
            ['c1', POS_C1],
            ['c2', POS_C2],
            ['d1', POS_D1],
        ])
        const result = mmrRerank(candidates, posMap, 3)
        expect(result).toHaveLength(3)
        // All nodes must be present (order may differ from input)
        expect(result.map(n => n.id).sort()).toEqual(['c1', 'c2', 'd1'])
    })
})

describe('mmrRerank: missing position data', () => {
    it('handles node with no positionMap entry gracefully (maxRedundancy=0)', () => {
        // If a node's position is missing (e.g., attractor ghosted after expansion),
        // treat it as maximally distinct (maxRedundancy=0) — it competes on relevance only.
        const candidates = [
            makeNode('c1', 'C1', 1.0),
            makeNode('ghost', 'Ghosted Node', 0.9),
            makeNode('d1', 'D1', 0.8),
        ]
        const posMap = new Map([
            ['c1', POS_C1],
            // 'ghost' missing from posMap
            ['d1', POS_D1],
        ])
        // Should not throw
        expect(() => mmrRerank(candidates, posMap, 2)).not.toThrow()
        const result = mmrRerank(candidates, posMap, 2)
        expect(result).toHaveLength(2)
        expect(result[0]!.id).toBe('c1')
    })
})

describe('spirit anchor pinning pattern', () => {
    // Tests the "forced inclusion" pattern used in expandForTask:
    //   1. Partition pool into spirit (pinned) + mechanics (MMR candidates)
    //   2. Spirit nodes always appear regardless of per-task relevance
    //   3. MMR diversity applies only to the mechanics remainder
    //
    // Without pinning, a domain-specific task pool with 40 high-relevance mechanics
    // can displace all spirit anchors — the agent loses its identity context.

    it('spirit nodes survive even with lower relevance than mechanics', () => {
        // Spirit node has relevance 0.10 — far below the mechanics (0.90–0.95).
        // Pure relevance or plain MMR would drop it from a 2-slot budget.
        const spiritNode = makeNodeWithDepth('s1', 'I am Plexo', 0.10, 'spirit')
        const m1 = makeNodeWithDepth('m1', 'Invoice PDF generation', 0.95, 'mechanics')
        const m2 = makeNodeWithDepth('m2', 'Stripe webhook handler', 0.90, 'mechanics')
        const m3 = makeNodeWithDepth('m3', 'PDF renderer tool', 0.88, 'mechanics')

        const spiritNodes = [spiritNode]
        const mechanicsNodes = [m1, m2, m3]
        const posMap = new Map([
            ['s1', [1, 0, 0, 0]],
            ['m1', [0, 0, 1, 0]],
            ['m2', [0, 0.01, 1, 0]],
            ['m3', [0, 0.02, 1, 0]],
        ])

        // Simulate expandForTask pinning logic: spirit nodes are always included,
        // MMR runs on mechanics only for remaining slots.
        const mechanicsSlots = Math.max(0, 2 - spiritNodes.length) // = 1
        const selectedMechanics = mmrRerank(mechanicsNodes, posMap, mechanicsSlots)
        const result = [...spiritNodes, ...selectedMechanics]

        expect(result).toHaveLength(2)
        expect(result.some(n => n.id === 's1')).toBe(true)  // spirit always included
        expect(result.some(n => n.id === 'm1')).toBe(true)  // highest-relevance mechanic
    })

    it('pure MMR (no pinning) would drop the low-relevance spirit node', () => {
        // Confirms the test premise: without pinning, spirit is displaced.
        const spiritNode = makeNodeWithDepth('s1', 'I am Plexo', 0.10, 'spirit')
        const m1 = makeNodeWithDepth('m1', 'Invoice PDF generation', 0.95, 'mechanics')
        const m2 = makeNodeWithDepth('m2', 'Stripe webhook handler', 0.90, 'mechanics')

        const allNodes = [spiritNode, m1, m2]
        const posMap = new Map([
            ['s1', [1, 0, 0, 0]],
            ['m1', [0, 0, 1, 0]],
            ['m2', [0, 0.01, 1, 0]],
        ])
        // Without pinning, all 3 nodes compete for 2 slots via plain MMR.
        const result = mmrRerank(allNodes, posMap, 2)

        // m1 and m2 both outscore s1 — s1 is dropped without pinning.
        expect(result.some(n => n.id === 's1')).toBe(false)
    })

    it('all spirit nodes are pinned when there are multiple spirit anchors', () => {
        const spirit1 = makeNodeWithDepth('s1', 'I am Plexo', 0.05, 'spirit')
        const spirit2 = makeNodeWithDepth('s2', 'Sovereignty', 0.08, 'spirit')
        const m1 = makeNodeWithDepth('m1', 'Invoice generator', 0.95, 'mechanics')
        const m2 = makeNodeWithDepth('m2', 'PDF tool', 0.92, 'mechanics')
        const m3 = makeNodeWithDepth('m3', 'Email sender', 0.89, 'mechanics')

        const spiritNodes = [spirit1, spirit2]
        const mechanicsNodes = [m1, m2, m3]
        const posMap = new Map([
            ['s1', [1, 0, 0, 0]],
            ['s2', [0.9, 0.1, 0, 0]],
            ['m1', [0, 0, 1, 0]],
            ['m2', [0, 0.01, 1, 0]],
            ['m3', [0.2, 0, 0.9, 0]],
        ])

        // maxNodes=3: 2 spirit slots + 1 mechanics slot
        const mechanicsSlots = Math.max(0, 3 - spiritNodes.length) // = 1
        const selectedMechanics = mmrRerank(mechanicsNodes, posMap, mechanicsSlots)
        const result = [...spiritNodes, ...selectedMechanics]

        expect(result).toHaveLength(3)
        expect(result.some(n => n.id === 's1')).toBe(true)
        expect(result.some(n => n.id === 's2')).toBe(true)
        expect(result.some(n => n.id === 'm1')).toBe(true) // highest-relevance mechanic
    })
})

describe('mmrRerank: lambda parameter', () => {
    it('lambda=1.0 degenerates to pure relevance order', () => {
        // When λ=1, score = 1.0×relevance − 0×redundancy → pure relevance.
        // All near-duplicates are selected in relevance order.
        const candidates = [
            makeNode('c1', 'C1', 1.0),
            makeNode('c2', 'C2', 0.99),  // near-duplicate
            makeNode('d1', 'D1', 0.98),  // distinct
        ]
        const posMap = new Map([
            ['c1', POS_C1],
            ['c2', POS_C2],
            ['d1', POS_D1],
        ])
        const result = mmrRerank(candidates, posMap, 2, 1.0)
        expect(result[0]!.id).toBe('c1')
        expect(result[1]!.id).toBe('c2')  // near-duplicate wins at λ=1
    })

    it('lambda=0.0 degenerates to anti-redundancy (novelty only)', () => {
        // When λ=0, score = −max_sim_to_selected → maximally distinct wins.
        // First pick: maxRedundancy=0 for all → all score 0, first candidate wins.
        // Second pick: pick the one least similar to c1.
        // d1 (cos to c1 = 0.866) is less similar to c1 than c2 (cos to c1 ≈ 0.999).
        // So: −0.866 > −0.999 → d1 wins on novelty.
        const candidates = [
            makeNode('c1', 'C1', 1.0),
            makeNode('c2', 'C2', 0.99),
            makeNode('d1', 'D1', 0.98),
        ]
        const posMap = new Map([
            ['c1', POS_C1],
            ['c2', POS_C2],
            ['d1', POS_D1],
        ])
        const result = mmrRerank(candidates, posMap, 2, 0.0)
        expect(result[0]!.id).toBe('c1')
        expect(result[1]!.id).toBe('d1')  // most novel wins at λ=0
    })
})

// ── MIN_MECHANICS_RELEVANCE threshold (0.05) ───────────────────────────────────
//
// Applies in expandForTask *before* mmrRerank is called. Tests here simulate the
// filtering pattern so the threshold boundary is verified in isolation.
//
// Theory: dense retrieval score thresholds prevent near-orthogonal documents from
// consuming the context budget when the pool is sparse (Karpukhin et al., DPR 2020).

describe('minimum mechanics relevance threshold pattern', () => {
    const MIN_MECHANICS_RELEVANCE = 0.05

    it('excludes mechanics below threshold while keeping those at or above', () => {
        // m1 (0.80) and m3 (0.05) pass; m2 (0.02) is filtered out.
        const spiritNode  = makeNodeWithDepth('s1', 'I am Plexo', 0.03, 'spirit')
        const highRel     = makeNodeWithDepth('m1', 'Code review tool', 0.80, 'mechanics')
        const nearOrth    = makeNodeWithDepth('m2', 'Cooking recipe', 0.02, 'mechanics')
        const borderline  = makeNodeWithDepth('m3', 'Git workflow', 0.05, 'mechanics')

        const posMap = new Map([
            ['s1', [1, 0, 0, 0]],
            ['m1', [0, 0, 1, 0]],
            ['m2', [1, 0, 0, 0]],   // different direction from task stimulus
            ['m3', [0, 0.3, 0.95, 0]],
        ])

        // Simulate expandForTask: filter mechanics, then MMR
        const allNodes = [spiritNode, highRel, nearOrth, borderline]
        const spiritNodes  = allNodes.filter(n => n.depthClass === 'spirit')
        const mechanicsNodes = allNodes.filter(
            n => n.depthClass !== 'spirit' && n.relevance >= MIN_MECHANICS_RELEVANCE
        )
        const selectedMechanics = mmrRerank(mechanicsNodes, posMap, 5)
        const result = [...spiritNodes, ...selectedMechanics]

        expect(result.some(n => n.id === 's1')).toBe(true)   // spirit always included
        expect(result.some(n => n.id === 'm1')).toBe(true)   // above threshold
        expect(result.some(n => n.id === 'm3')).toBe(true)   // exactly at threshold
        expect(result.some(n => n.id === 'm2')).toBe(false)  // below threshold — filtered
    })

    it('without threshold, near-orthogonal mechanics fill slots in sparse pools', () => {
        // Confirms the problem the threshold solves: when budget > pool size, every
        // candidate is selected regardless of relevance.
        const highRel  = makeNodeWithDepth('m1', 'Code review', 0.80, 'mechanics')
        const nearOrth = makeNodeWithDepth('m2', 'Cooking recipe', 0.02, 'mechanics')

        const posMap = new Map([
            ['m1', [0, 0, 1, 0]],
            ['m2', [1, 0, 0, 0]],
        ])

        // Without filter: both are selected when budget (5) > pool size (2)
        const withoutFilter = mmrRerank([highRel, nearOrth], posMap, 5)
        expect(withoutFilter.some(n => n.id === 'm2')).toBe(true)  // noise selected!

        // With threshold: only the high-relevance mechanic survives
        const filtered = [highRel, nearOrth].filter(n => n.relevance >= MIN_MECHANICS_RELEVANCE)
        const withFilter = mmrRerank(filtered, posMap, 5)
        expect(withFilter.some(n => n.id === 'm2')).toBe(false)  // excluded by threshold
        expect(withFilter.some(n => n.id === 'm1')).toBe(true)
    })

    it('all mechanics filtered → only spirit nodes in result', () => {
        // Edge case: if no mechanics are relevant enough, the context block contains
        // only spirit anchors — the agent relies on identity without domain knowledge.
        const spirit  = makeNodeWithDepth('s1', 'I am Plexo', 0.03, 'spirit')
        const noise1  = makeNodeWithDepth('m1', 'Noise A', 0.01, 'mechanics')
        const noise2  = makeNodeWithDepth('m2', 'Noise B', 0.03, 'mechanics')

        const posMap = new Map([
            ['s1', [1, 0, 0, 0]],
            ['m1', [0, 1, 0, 0]],
            ['m2', [0, 0, 1, 0]],
        ])

        const allNodes = [spirit, noise1, noise2]
        const spiritNodes    = allNodes.filter(n => n.depthClass === 'spirit')
        const mechanicsNodes = allNodes.filter(
            n => n.depthClass !== 'spirit' && n.relevance >= MIN_MECHANICS_RELEVANCE
        )
        const selectedMechanics = mmrRerank(mechanicsNodes, posMap, 5)
        const result = [...spiritNodes, ...selectedMechanics]

        expect(result).toHaveLength(1)
        expect(result[0]!.id).toBe('s1')
        expect(result.some(n => n.depthClass === 'mechanics')).toBe(false)
    })
})

// ── Spirit anchor pool guarantee ───────────────────────────────────────────────
//
// expandForTask must guarantee spirits are in the final context even when
// expand() truncates them from the candidate pool (mature workspace edge case).
// The guarantee works by fetching spirits directly from record.attractors and
// appending any that expand() omitted. These tests verify the filtering logic
// that implements the guarantee.

describe('spirit anchor pool guarantee: expand() omission detection', () => {
    it('spirits absent from pool result are detected by set difference', () => {
        // Simulates the pool-exclusion scenario: record has 2 spirit attractors
        // but expand() only returned 1 in its pool (e.g., budget ran out on mechanics).
        const poolNodes = [
            makeNodeWithDepth('s1', 'I am Plexo', 0.20, 'spirit'),      // in pool
            makeNodeWithDepth('m1', 'Invoice tool', 0.95, 'mechanics'),
        ]
        const allSpiritIds = new Set(['s1', 's2'])                        // s2 missing
        const poolSpiritIds = new Set(poolNodes.filter(n => n.depthClass === 'spirit').map(n => n.id))

        const missingSpirits = [...allSpiritIds].filter(id => !poolSpiritIds.has(id))
        expect(missingSpirits).toEqual(['s2'])                             // gap detected
    })

    it('no spirits are missing when all appear in pool result', () => {
        const poolNodes = [
            makeNodeWithDepth('s1', 'I am Plexo', 0.20, 'spirit'),
            makeNodeWithDepth('s2', 'Sovereignty', 0.15, 'spirit'),
            makeNodeWithDepth('m1', 'Invoice tool', 0.95, 'mechanics'),
        ]
        const allSpiritIds = new Set(['s1', 's2'])
        const poolSpiritIds = new Set(poolNodes.filter(n => n.depthClass === 'spirit').map(n => n.id))

        const missingSpirits = [...allSpiritIds].filter(id => !poolSpiritIds.has(id))
        expect(missingSpirits).toHaveLength(0)
    })
})
