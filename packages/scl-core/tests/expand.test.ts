import { describe, it, expect } from 'vitest'
import { boot } from '../src/boot.js'
import { expand } from '../src/expand.js'
import type { GoldenRecord } from '../src/types.js'
import { generateId } from '../src/utils/id.js'
import { cosineSimilarity } from '../src/utils/vector.js'
import { V_IDENTITY, V_OPERATOR, V_CODING, V_DEVOPS, V_UNRELATED, V_ZERO, TEST_WORKSPACE } from './fixtures/vectors.js'

function makeRecord(): GoldenRecord {
    return boot({
        workspaceId: TEST_WORKSPACE,
        spiritAnchors: [
            { label: 'Identity', type: 'entity', position: V_IDENTITY },
            { label: 'Operator', type: 'entity', position: V_OPERATOR },
            { label: 'Coding', type: 'action', position: V_CODING },
            { label: 'DevOps', type: 'action', position: V_DEVOPS },
        ],
    })
}

describe('expand', () => {
    it('returns relevant nodes for a stimulus', () => {
        const record = makeRecord()
        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L0',
            contextBudget: 100,
            priority: 'relevance',
        })

        expect(result.nodes.length).toBeGreaterThan(0)
        // Identity should be most relevant
        expect(result.nodes[0]!.label).toBe('Identity')
        expect(result.nodes[0]!.relevance).toBeCloseTo(1.0, 1)
    })

    it('respects budget at L0 (10 tokens per attractor)', () => {
        const record = makeRecord()
        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L0',
            contextBudget: 25, // fits 2 attractors at 10 each
            priority: 'relevance',
        })

        expect(result.attractorsExpanded).toBeLessThanOrEqual(2)
        expect(result.budgetUsed).toBeLessThanOrEqual(25)
    })

    it('respects budget at L1 (50 tokens per attractor)', () => {
        const record = makeRecord()
        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L1',
            contextBudget: 100, // fits 2 at 50 each
            priority: 'relevance',
        })

        expect(result.attractorsExpanded).toBeLessThanOrEqual(2)
        expect(result.budgetUsed).toBeLessThanOrEqual(100)
    })

    it('L2 ignores budget (advisory only)', () => {
        const record = makeRecord()
        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L2',
            contextBudget: 1, // tiny budget — L2 ignores it
            priority: 'relevance',
        })

        expect(result.attractorsExpanded).toBe(4) // all attractors
    })

    it('L0 does not include attributes', () => {
        const record = makeRecord()
        record.attractors[0]!.attributes = { key: 'value' }

        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L0',
            contextBudget: 1000,
            priority: 'relevance',
        })

        const identityNode = result.nodes.find(n => n.label === 'Identity')!
        expect(identityNode.attributes).toBeUndefined()
    })

    it('L1 includes attributes', () => {
        const record = makeRecord()
        record.attractors[0]!.attributes = { key: 'value' }

        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L1',
            contextBudget: 1000,
            priority: 'relevance',
        })

        const identityNode = result.nodes.find(n => n.label === 'Identity')!
        expect(identityNode.attributes).toEqual({ key: 'value' })
    })

    it('salience priority sorts by salience first', () => {
        const record = makeRecord()
        record.attractors[2]!.salience = 0.9 // Coding
        record.attractors[0]!.salience = 0.1 // Identity
        record.attractors[1]!.salience = 0.1 // Operator
        record.attractors[3]!.salience = 0.1 // DevOps

        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L0',
            contextBudget: 20, // only 2
            priority: 'salience',
        })

        expect(result.nodes[0]!.label).toBe('Coding') // higher salience wins
    })

    it('recency priority sorts by lastMutatedAt first', () => {
        const record = makeRecord()
        record.attractors[2]!.lastMutatedAt = Date.now() + 1000 // Coding is newest

        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L0',
            contextBudget: 10, // only 1
            priority: 'recency',
        })

        expect(result.nodes[0]!.label).toBe('Coding')
    })

    it('returns empty for empty record', () => {
        const record = boot({ workspaceId: TEST_WORKSPACE, spiritAnchors: [] })
        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L0',
            contextBudget: 1000,
            priority: 'relevance',
        })

        expect(result.nodes).toHaveLength(0)
        expect(result.budgetUsed).toBe(0)
        expect(result.totalAttractors).toBe(0)
    })

    it('tracks regionsActivated', () => {
        const record = makeRecord()
        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L0',
            contextBudget: 1000,
            priority: 'relevance',
        })

        expect(result.regionsActivated.length).toBeGreaterThan(0)
        expect(result.regionsActivated[0]).toBe(record.regions[0]!.id)
    })

    it('reports totalAttractors and attractorsExpanded', () => {
        const record = makeRecord()
        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L0',
            contextBudget: 20,
            priority: 'relevance',
        })

        expect(result.totalAttractors).toBe(4)
        expect(result.attractorsExpanded).toBeLessThanOrEqual(2)
    })
})

// ── Cluster-hypothesis (region-boosted) ranking ───────────────────────────────
//
// The cluster hypothesis: attractors in regions whose centroid is semantically
// aligned with the stimulus should be preferred over outlier attractors that
// happen to have slightly higher direct cosine similarity but live in an
// off-topic region.
//
// Without the boost, an attractor_B in an unrelated region can outrank
// attractor_A in the correct region because directSim(B) > directSim(A).
// With the 0.75/0.15/0.10 (direct/region/salience) weighted combination,
// the topic-coherent attractor wins.

describe('relevance ranking quality — cluster-hypothesis region boost', () => {
    function makeTwoRegionRecord(): GoldenRecord {
        // Two isolated regions in 4-D space:
        //   Region A (coding domain) — centroid = V_CODING = [0,0,1,0]
        //   Region B (identity domain) — centroid = V_IDENTITY = [1,0,0,0]
        //
        // attractor_A lives in Region A with directSim ≈ 0.995 to V_CODING.
        // attractor_B lives in Region B with directSim ≈ 0.9997 to V_CODING —
        //   slightly HIGHER direct sim, but wrong region.
        //
        // Pure directSim → B ranks first.
        // Region-boosted (0.8·direct + 0.2·regionSim) → A ranks first.
        const now = Date.now()
        const regionA = { id: 'rA', label: 'coding',   centroid: V_CODING,    radius: 1, density: 1, children: [] }
        const regionB = { id: 'rB', label: 'identity', centroid: V_IDENTITY,  radius: 1, density: 1, children: [] }

        // attractor_A: [0, 0.1, 0.995, 0] — directSim to V_CODING ≈ 0.995/√1.0001 ≈ 0.9950
        const attractorA = {
            id: generateId(), label: 'attractor-A',
            position: [0, 0.1, 0.995, 0],
            regionId: 'rA', type: 'action' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now,
        }

        // attractor_B: [0.01, 0, 0.997, 0] — directSim to V_CODING ≈ 0.997/√0.994109 ≈ 0.9997
        // (higher direct sim, but sits in the identity region)
        const attractorB = {
            id: generateId(), label: 'attractor-B',
            position: [0.01, 0, 0.997, 0],
            regionId: 'rB', type: 'action' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now,
        }

        return {
            id: 'test-two-region', version: 'scl/1.0', workspaceId: TEST_WORKSPACE,
            regions: [regionA, regionB],
            attractors: [attractorA, attractorB],
            transformations: [], ledgerRefs: [],
            bootedAt: now, lastMutatedAt: now,
        }
    }

    it('attractor_B has higher raw directSim to the stimulus', () => {
        // Verify the test premise: without any boost, B would rank first.
        const record = makeTwoRegionRecord()
        const [a, b] = record.attractors
        // cos([0,0,1,0], [0,0.1,0.995,0]) < cos([0,0,1,0], [0.01,0,0.997,0])
        const simA = cosineSimilarity(a!.position, V_CODING)
        const simB = cosineSimilarity(b!.position, V_CODING)
        expect(simB).toBeGreaterThan(simA)
    })

    it('region-boosted ranking places attractor_A (correct region) first', () => {
        // Stimulus = V_CODING.  Region A centroid = V_CODING → regionSim = 1.0.
        // Both attractors have salience = 0.5 (mechanics).
        //   combined_A = 0.75 * ~0.995 + 0.15 * 1.0 + 0.10 * 0.5 ≈ 0.746 + 0.150 + 0.050 = 0.946
        // Region B centroid = V_IDENTITY → regionSim to V_CODING = 0.
        //   combined_B = 0.75 * ~0.9997 + 0.15 * 0.0 + 0.10 * 0.5 ≈ 0.750 + 0.000 + 0.050 = 0.800
        // So A must rank before B.
        const record = makeTwoRegionRecord()
        const result = expand(record, {
            stimulus: V_CODING,
            level: 'L0',
            contextBudget: 100,
            priority: 'relevance',
        })

        expect(result.nodes.length).toBe(2)
        expect(result.nodes[0]!.label).toBe('attractor-A')
        // node.relevance is still the raw directSim (not the combined score)
        expect(result.nodes[0]!.relevance).toBeCloseTo(0.995, 2)
        expect(result.nodes[1]!.label).toBe('attractor-B')
    })

    it('spirit anchor (salience=1.0) beats mechanics (salience=0.5) with slightly lower directSim', () => {
        // Proves the salience authority prior (0.10 * salience term).
        // spirit:    directSim=0.80, salience=1.0 → score = 0.75*0.80 + 0.15*1.0 + 0.10*1.0 = 0.850
        // mechanics: directSim=0.82, salience=0.5 → score = 0.75*0.82 + 0.15*1.0 + 0.10*0.5 = 0.815
        // Without salience term: mechanics wins (0.80*0.82 + 0.20*1.0 = 0.856 > 0.84).
        // With salience term:   spirit wins (0.850 > 0.815).
        const now = Date.now()
        const region = { id: 'r1', label: 'test', centroid: V_IDENTITY, radius: 1, density: 1, children: [] }

        // spirit at [0.80, 0, 0, 0.6]: magnitude=1.0, directSim to [1,0,0,0] = 0.80
        const spirit = {
            id: 'spirit-1', label: 'spirit-anchor',
            position: [0.80, 0, 0, 0.6],
            regionId: 'r1', type: 'entity' as const, depthClass: 'spirit' as const,
            salience: 1.0, driftProtected: true, mutationCount: 50, lastMutatedAt: now,
        }

        // mechanics at [0.82, 0, 0, 0.572]: magnitude≈1.0, directSim to [1,0,0,0] ≈ 0.82
        const mechanics = {
            id: 'mech-1', label: 'mechanics-attractor',
            position: [0.82, 0, 0, 0.572],
            regionId: 'r1', type: 'action' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now,
        }

        const record: GoldenRecord = {
            id: 'test', version: 'scl/1.0', workspaceId: TEST_WORKSPACE,
            regions: [region], attractors: [spirit, mechanics],
            transformations: [], ledgerRefs: [], bootedAt: now, lastMutatedAt: now,
        }

        // Verify premise: mechanics has higher raw directSim
        expect(cosineSimilarity(mechanics.position, V_IDENTITY)).toBeGreaterThan(
            cosineSimilarity(spirit.position, V_IDENTITY)
        )

        const result = expand(record, {
            stimulus: V_IDENTITY, level: 'L0', contextBudget: 100, priority: 'relevance',
        })

        expect(result.nodes[0]!.label).toBe('spirit-anchor')
        expect(result.nodes[1]!.label).toBe('mechanics-attractor')
    })

    it('salience and recency priorities are unaffected by the region boost', () => {
        const record = makeTwoRegionRecord()
        record.attractors[1]!.salience = 0.9  // B has higher salience

        const result = expand(record, {
            stimulus: V_CODING,
            level: 'L0',
            contextBudget: 10,  // only 1 slot
            priority: 'salience',
        })

        // B should win here because salience wins over region boost
        expect(result.nodes[0]!.label).toBe('attractor-B')
    })
})

// ── regionsActivated accuracy ──────────────────────────────────────────────────
//
// regionsActivated must reflect only the regions whose attractors made it into
// the final selected set, not all regions in the record.

describe('regionsActivated — reflects selected nodes only', () => {
    it('single-region record: activated set equals that region', () => {
        const record = makeRecord()  // 4 attractors, 1 root region, budget fits all
        const result = expand(record, {
            stimulus: V_IDENTITY, level: 'L0', contextBudget: 1000, priority: 'relevance',
        })
        expect(result.regionsActivated).toHaveLength(1)
        expect(result.regionsActivated[0]).toBe(record.regions[0]!.id)
    })

    it('tight budget selects nodes from only one region — other region absent from activated', () => {
        // Region A has a highly relevant attractor; Region B has a low-relevance attractor.
        // Budget = 1 slot → only Region A's attractor is selected.
        // regionsActivated must contain rA but NOT rB.
        const now = Date.now()
        const regionA = { id: 'rA', label: 'coding', centroid: V_CODING, radius: 1, density: 1, children: [] }
        const regionB = { id: 'rB', label: 'identity', centroid: V_IDENTITY, radius: 1, density: 1, children: [] }

        // attractor in region A — directly matches stimulus
        const attrA = {
            id: 'a1', label: 'Coding Concept', position: V_CODING,
            regionId: 'rA', type: 'action' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now,
        }
        // attractor in region B — orthogonal to stimulus
        const attrB = {
            id: 'b1', label: 'Identity Concept', position: V_IDENTITY,
            regionId: 'rB', type: 'entity' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now,
        }

        const record: GoldenRecord = {
            id: 'test', version: 'scl/1.0', workspaceId: TEST_WORKSPACE,
            regions: [regionA, regionB], attractors: [attrA, attrB],
            transformations: [], ledgerRefs: [], bootedAt: now, lastMutatedAt: now,
        }

        // Budget = exactly 1 attractor slot
        const result = expand(record, {
            stimulus: V_CODING, level: 'L0', contextBudget: 10, priority: 'relevance',
        })

        expect(result.attractorsExpanded).toBe(1)
        expect(result.nodes[0]!.label).toBe('Coding Concept')
        // Only region A contributed a selected node → rB must be absent
        expect(result.regionsActivated).toContain('rA')
        expect(result.regionsActivated).not.toContain('rB')
    })
})

// ── Anti-correlation filter ────────────────────────────────────────────────────
//
// In relevance-priority mode, attractors with negative cosine similarity to the
// stimulus are semantically opposed — they are noise, not signal.
// Standard IR: a document with cosine < 0 to the query should not be returned.

describe('anti-correlation filter in relevance-priority mode', () => {
    it('excludes attractor with negative cosine similarity to stimulus', () => {
        // V_UNRELATED = [-1,-1,-1,-1]: cos(V_UNRELATED, V_IDENTITY) = -1/(1*2) = -0.5 < 0
        const now = Date.now()
        const region = { id: 'r1', label: 'root', centroid: V_IDENTITY, radius: 1, density: 2, children: [] }
        const positive = {
            id: 'pos', label: 'Positive', position: V_IDENTITY,
            regionId: 'r1', type: 'entity' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now,
        }
        const negative = {
            id: 'neg', label: 'Negative', position: V_UNRELATED,
            regionId: 'r1', type: 'entity' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now,
        }

        const record: GoldenRecord = {
            id: 'test', version: 'scl/1.0', workspaceId: TEST_WORKSPACE,
            regions: [region], attractors: [positive, negative],
            transformations: [], ledgerRefs: [], bootedAt: now, lastMutatedAt: now,
        }

        const result = expand(record, {
            stimulus: V_IDENTITY, level: 'L0', contextBudget: 1000, priority: 'relevance',
        })

        expect(result.nodes.find(n => n.label === 'Positive')).toBeDefined()
        expect(result.nodes.find(n => n.label === 'Negative')).toBeUndefined()
    })

    it('anti-correlation filter does NOT apply in salience-priority mode', () => {
        // In salience mode the intent is to surface trusted concepts regardless of
        // stimulus alignment — the filter must not suppress high-salience attractors.
        const now = Date.now()
        const region = { id: 'r1', label: 'root', centroid: V_IDENTITY, radius: 1, density: 1, children: [] }
        const negative = {
            id: 'neg', label: 'High-Salience Anti-Correlated', position: V_UNRELATED,
            regionId: 'r1', type: 'entity' as const, depthClass: 'spirit' as const,
            salience: 1.0, driftProtected: true, mutationCount: 50, lastMutatedAt: now,
        }

        const record: GoldenRecord = {
            id: 'test', version: 'scl/1.0', workspaceId: TEST_WORKSPACE,
            regions: [region], attractors: [negative],
            transformations: [], ledgerRefs: [], bootedAt: now, lastMutatedAt: now,
        }

        const result = expand(record, {
            stimulus: V_IDENTITY, level: 'L0', contextBudget: 1000, priority: 'salience',
        })

        // Salience mode must not drop the attractor even though cosine < 0
        expect(result.nodes.find(n => n.label === 'High-Salience Anti-Correlated')).toBeDefined()
    })

    it('records zero nodes when all attractors are anti-correlated in relevance mode', () => {
        const now = Date.now()
        const region = { id: 'r1', label: 'root', centroid: V_UNRELATED, radius: 1, density: 1, children: [] }
        const anti = {
            id: 'a1', label: 'Anti', position: V_UNRELATED,
            regionId: 'r1', type: 'entity' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now,
        }
        const record: GoldenRecord = {
            id: 'test', version: 'scl/1.0', workspaceId: TEST_WORKSPACE,
            regions: [region], attractors: [anti],
            transformations: [], ledgerRefs: [], bootedAt: now, lastMutatedAt: now,
        }

        const result = expand(record, {
            stimulus: V_IDENTITY, level: 'L0', contextBudget: 1000, priority: 'relevance',
        })

        expect(result.nodes).toHaveLength(0)
        expect(result.budgetUsed).toBe(0)
        expect(result.regionsActivated).toHaveLength(0)
    })
})

// ── Edge deduplication and cap ─────────────────────────────────────────────────
//
// With a single region, every transformation rule fans out to O(N²) attractor
// pairs. Without a cap, 40 selected nodes and 10 rules → ~15 000 edge lines.

describe('L1 edge output — deduplication and cap', () => {
    it('caps edges at 20 even when many attractor pairs qualify', () => {
        // Build a record with 10 attractors all in the same region,
        // plus one intra-region transformation rule.
        const now = Date.now()
        const regionId = 'r1'
        const region = {
            id: regionId, label: 'root', centroid: V_IDENTITY,
            radius: 1, density: 10, children: [],
        }

        const attractors = Array.from({ length: 10 }, (_, i) => ({
            id: `a${i}`,
            label: `Concept ${i}`,
            position: i === 0 ? V_IDENTITY : i === 1 ? V_OPERATOR : i === 2 ? V_CODING : V_DEVOPS,
            regionId,
            type: 'entity' as const,
            depthClass: 'mechanics' as const,
            salience: 0.5,
            driftProtected: false,
            mutationCount: 0,
            lastMutatedAt: now,
        }))

        const rule = {
            id: 'rule1',
            sourceRegionId: regionId,
            targetRegionId: regionId,
            relationType: 'ENABLES' as const,
            transform: [],
            modality: 'factual' as const,
            confidence: 0.8,
            depthClass: 'mechanics' as const,
        }

        const record: GoldenRecord = {
            id: 'test', version: 'scl/1.0', workspaceId: TEST_WORKSPACE,
            regions: [region],
            attractors,
            transformations: [rule],
            ledgerRefs: [],
            bootedAt: now,
            lastMutatedAt: now,
        }

        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L1',
            contextBudget: 10_000,
            priority: 'relevance',
        })

        // 10 nodes in one region with 1 rule → 10*9 = 90 raw pairs, capped at 20
        expect(result.edges.length).toBeLessThanOrEqual(20)
    })

    it('deduplicates edges with identical (source, target, relation)', () => {
        // Build a record where two rules share the same source+target region
        // and the same relation type — normally prevented by mutate() but
        // possible in manually constructed records.
        const now = Date.now()
        const regionId = 'r1'
        const region = { id: regionId, label: 'root', centroid: V_IDENTITY, radius: 1, density: 2, children: [] }

        const a1 = { id: 'a1', label: 'Alpha', position: V_IDENTITY, regionId, type: 'entity' as const, depthClass: 'mechanics' as const, salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now }
        const a2 = { id: 'a2', label: 'Beta', position: V_OPERATOR, regionId, type: 'entity' as const, depthClass: 'mechanics' as const, salience: 0.5, driftProtected: false, mutationCount: 0, lastMutatedAt: now }

        const makeRule = (id: string) => ({
            id, sourceRegionId: regionId, targetRegionId: regionId,
            relationType: 'ENABLES' as const, transform: [],
            modality: 'factual' as const, confidence: 0.8, depthClass: 'mechanics' as const,
        })

        const record: GoldenRecord = {
            id: 'test', version: 'scl/1.0', workspaceId: TEST_WORKSPACE,
            regions: [region], attractors: [a1, a2],
            transformations: [makeRule('r1'), makeRule('r2')],
            ledgerRefs: [], bootedAt: now, lastMutatedAt: now,
        }

        const result = expand(record, {
            stimulus: V_IDENTITY, level: 'L1', contextBudget: 10_000, priority: 'relevance',
        })

        // Two rules → would produce 4 edges without dedup (2*2 pairs minus self = 2 per rule = 4).
        // With dedup by (source, target, relation), only 2 unique edges.
        expect(result.edges.length).toBe(2)
    })

    it('edge budget fills from highest-confidence rules first', () => {
        // 10 attractors in one region → each rule generates 90 source-target pairs.
        // MAX_EDGES=20 cap means only one rule's pairs fit in the budget.
        //
        // Two rules: ENABLES (confidence=0.3, inserted first) and REQUIRES (confidence=0.9).
        // Without confidence-ordered sorting: ENABLES fills the cap; REQUIRES never runs.
        // With confidence-ordered sorting:    REQUIRES fills the cap first.
        //
        // IR theory: constrained retrieval output should rank by evidence strength.
        const now = Date.now()
        const regionId = 'r1'
        const region = {
            id: regionId, label: 'root', centroid: V_IDENTITY,
            radius: 1, density: 10, children: [],
        }

        const attractors = Array.from({ length: 10 }, (_, i) => ({
            id: `a${i}`,
            label: `Concept ${i}`,
            position: i === 0 ? V_IDENTITY : i === 1 ? V_OPERATOR : i === 2 ? V_CODING : V_DEVOPS,
            regionId,
            type: 'entity' as const,
            depthClass: 'mechanics' as const,
            salience: 0.5,
            driftProtected: false,
            mutationCount: 0,
            lastMutatedAt: now,
        }))

        // lowRule inserted first — without sorting it would run first and fill the cap
        const lowRule = {
            id: 'r-low',
            sourceRegionId: regionId,
            targetRegionId: regionId,
            relationType: 'ENABLES' as const,
            transform: [],
            modality: 'factual' as const,
            confidence: 0.3,
            depthClass: 'mechanics' as const,
        }
        const highRule = {
            id: 'r-high',
            sourceRegionId: regionId,
            targetRegionId: regionId,
            relationType: 'REQUIRES' as const,
            transform: [],
            modality: 'factual' as const,
            confidence: 0.9,
            depthClass: 'mechanics' as const,
        }

        const record: GoldenRecord = {
            id: 'test', version: 'scl/1.0', workspaceId: TEST_WORKSPACE,
            regions: [region],
            attractors,
            transformations: [lowRule, highRule], // low inserted first — the adversarial order
            ledgerRefs: [],
            bootedAt: now,
            lastMutatedAt: now,
        }

        const result = expand(record, {
            stimulus: V_IDENTITY,
            level: 'L1',
            contextBudget: 10_000,
            priority: 'relevance',
        })

        // All returned edges must be from the high-confidence rule (REQUIRES, 0.9),
        // not the low-confidence rule that was inserted first (ENABLES, 0.3).
        expect(result.edges.length).toBeGreaterThan(0)
        expect(result.edges.every(e => e.relation === 'REQUIRES')).toBe(true)
        expect(result.edges[0]!.confidence).toBe(0.9)
    })
})

// ── Stimulus dimension guard ───────────────────────────────────────────────────
//
// When stimulus.length ≠ attractor position dims, cosineSimilarity returns 0 for
// every attractor. Relevance-mode filter allows 0 (not < 0), so nodes are returned
// with relevance=0 — the stimulus has no effect on ranking. Return empty instead.

describe('stimulus dimension guard', () => {
    it('returns empty result when stimulus dimension mismatches record attractors', () => {
        // makeRecord() produces 4-dim attractors. Passing a 3-dim stimulus currently
        // causes all cosine similarities to return 0, then nodes are sorted by salience/
        // region alone — the stimulus is silently ignored. The guard detects this and
        // returns empty so the caller can skip SCL context rather than inject garbage.
        const record = makeRecord()  // 4-dim attractors

        // Verify premise: without guard, nodes WOULD be returned (relevance=0, not < 0)
        // — this block documents the pre-guard behavior.
        // (Not a test assertion: just shows the guard changes observable behavior.)

        const result = expand(record, {
            stimulus: [1, 0, 0], // 3-dim — mismatches 4-dim attractors
            level: 'L0',
            contextBudget: 1000,
            priority: 'relevance',
        })

        expect(result.nodes).toHaveLength(0)
        expect(result.budgetUsed).toBe(0)
        // totalAttractors still reported so callers know the record is non-empty
        expect(result.totalAttractors).toBe(4)
    })

    it('proceeds normally when stimulus matches attractor dimensions', () => {
        const record = makeRecord()  // 4-dim attractors
        const result = expand(record, {
            stimulus: V_IDENTITY,  // 4-dim — matches
            level: 'L0',
            contextBudget: 1000,
            priority: 'relevance',
        })
        expect(result.nodes.length).toBeGreaterThan(0)
    })
})
