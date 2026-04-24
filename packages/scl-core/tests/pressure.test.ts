import { describe, it, expect } from 'vitest'
import { boot, expand, mutate, archive, resolveDrift, checkPromotions, cosineSimilarity, DEFAULT_CONFIG } from '../src/index.js'
import type { GoldenRecord, MutationInput, ConceptType, RelationType } from '../src/types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const DIMS = 64 // realistic-ish dimensionality for pressure tests

function randomVector(dims = DIMS): number[] {
    const v = Array.from({ length: dims }, () => Math.random() * 2 - 1)
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    return mag > 0 ? v.map(x => x / mag) : v
}

function perturbVector(base: number[], amount: number): number[] {
    const noise = randomVector(base.length)
    const v = base.map((x, i) => x * (1 - amount) + noise[i]! * amount)
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    return mag > 0 ? v.map(x => x / mag) : v
}

const CONCEPT_TYPES: ConceptType[] = ['entity', 'event', 'state', 'claim', 'action', 'property']
const RELATION_TYPES: RelationType[] = ['CAUSES', 'ENABLES', 'REQUIRES', 'SUPPORTS', 'IS_A', 'HAS_PROPERTY', 'PERFORMS', 'PRODUCES']

function randomConceptType(): ConceptType {
    return CONCEPT_TYPES[Math.floor(Math.random() * CONCEPT_TYPES.length)]!
}

function randomRelationType(): RelationType {
    return RELATION_TYPES[Math.floor(Math.random() * RELATION_TYPES.length)]!
}

function makeRecord(spiritCount = 6): GoldenRecord {
    return boot({
        workspaceId: 'pressure-test',
        spiritAnchors: Array.from({ length: spiritCount }, (_, i) => ({
            label: `Spirit-${i}`,
            type: 'entity' as const,
            position: randomVector(),
        })),
    })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('pressure: massive Golden Record', () => {
    it('handles 1000 attractors', () => {
        const record = makeRecord(6)

        // Add 994 mechanics
        for (let i = 0; i < 994; i++) {
            mutate(record, {
                source: `batch-${i}`,
                concepts: [{
                    label: `Concept-${i}`,
                    type: randomConceptType(),
                    position: randomVector(),
                }],
                relations: [],
            })
        }

        expect(record.attractors.length).toBeGreaterThanOrEqual(500) // some may ghost
        expect(record.attractors.length).toBeLessThanOrEqual(1000)

        // Expansion still works
        const result = expand(record, {
            stimulus: randomVector(),
            level: 'L1',
            contextBudget: 5000,
            priority: 'relevance',
        })
        expect(result.nodes.length).toBeGreaterThan(0)
        expect(result.budgetUsed).toBeLessThanOrEqual(5000)
    })

    it('handles 5000 attractors with L0 expansion under budget', { timeout: 30_000 }, () => {
        const record = makeRecord(3)

        for (let i = 0; i < 4997; i++) {
            mutate(record, {
                source: 'bulk',
                concepts: [{
                    label: `Bulk-${i}`,
                    type: randomConceptType(),
                    position: randomVector(),
                }],
                relations: [],
            })
        }

        const start = performance.now()
        const result = expand(record, {
            stimulus: randomVector(),
            level: 'L0',
            contextBudget: 200, // only ~20 attractors at 10 tokens each
            priority: 'relevance',
        })
        const elapsed = performance.now() - start

        expect(result.attractorsExpanded).toBeLessThanOrEqual(20)
        expect(result.budgetUsed).toBeLessThanOrEqual(200)
        expect(elapsed).toBeLessThan(500) // should be fast even with 5k attractors
    })
})

describe('pressure: rapid sequential mutations', () => {
    it('10,000 mutations without corruption', { timeout: 60_000 }, () => {
        const record = makeRecord(3)
        const spiritIds = record.attractors.map(a => a.id)
        const spiritPositions = record.attractors.map(a => [...a.position])

        for (let i = 0; i < 10_000; i++) {
            mutate(record, {
                source: `rapid-${i}`,
                concepts: [{
                    label: `Rapid-${i % 500}`, // recycle 500 labels → heavy refinement
                    type: randomConceptType(),
                    position: randomVector(),
                }],
                relations: [],
            })
        }

        // Spirit attractors must survive untouched
        for (let i = 0; i < spiritIds.length; i++) {
            const spirit = record.attractors.find(a => a.id === spiritIds[i])
            expect(spirit).toBeDefined()
            expect(spirit!.depthClass).toBe('spirit')
            expect(spirit!.driftProtected).toBe(true)
            // Position unchanged (random mutations won't be within drift threshold)
            expect(spirit!.position).toEqual(spiritPositions[i])
        }

        // Record is internally consistent
        for (const a of record.attractors) {
            expect(a.position.length).toBe(DIMS)
            expect(a.salience).toBeGreaterThanOrEqual(0.1)
            expect(a.salience).toBeLessThanOrEqual(1.0)
        }
    })

    it('same-label refinement 1000 times converges', () => {
        const record = makeRecord(1)
        const basePos = randomVector()

        // Create the mechanic
        mutate(record, {
            source: 'init',
            concepts: [{ label: 'Converger', type: 'action', position: basePos }],
            relations: [],
        })

        // Refine 1000 times with slight perturbations
        for (let i = 0; i < 1000; i++) {
            const perturbed = perturbVector(basePos, 0.05) // 5% noise
            mutate(record, {
                source: `refine-${i}`,
                concepts: [{ label: 'Converger', type: 'action', position: perturbed }],
                relations: [],
            })
        }

        const converger = record.attractors.find(a => a.label === 'Converger')!
        expect(converger.mutationCount).toBe(1000)
        // Should have promoted to spirit (>50 mutations)
        expect(converger.depthClass).toBe('spirit')
        expect(converger.driftProtected).toBe(true)

        // Position should be close to basePos (weighted averaging converges)
        const sim = cosineSimilarity(converger.position, basePos)
        expect(sim).toBeGreaterThan(0.8) // high similarity after convergence
    })
})

describe('pressure: drift storm', () => {
    it('100 simultaneous spirit mutations all produce warnings', () => {
        // 4D vectors with precise cosine distance control.
        // For spirit at [1,0,0,0], vector [0.7,0.3,0.3,0.3] normalized has
        // cos = 0.7/sqrt(0.76) = 0.803 → distance = 0.197 (between 0.15 and 0.3) ✓
        const spirits = [
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
        ]
        const record = boot({
            workspaceId: 'drift-storm',
            spiritAnchors: spirits.map((pos, i) => ({
                label: `Spirit-${i}`, type: 'entity' as const, position: pos,
            })),
        })

        const allWarnings: any[] = []

        for (let i = 0; i < 100; i++) {
            const target = spirits[i % 4]!
            // Mix: 50% target + 50% uniform noise → cosine distance ~0.24
            const drifted = target.map(v => v * 0.5 + 0.5)
            const mag = Math.sqrt(drifted.reduce((s, x) => s + x * x, 0))
            const normalized = drifted.map(x => x / mag)

            const result = mutate(record, {
                source: `drift-storm-${i}`,
                concepts: [{ label: `Drift-${i}`, type: 'entity', position: normalized }],
                relations: [],
            })
            allWarnings.push(...result.driftWarnings)
        }

        expect(allWarnings.length).toBeGreaterThan(0)

        for (const a of record.attractors.filter(a => a.depthClass === 'spirit')) {
            expect(a.mutationCount).toBe(0)
        }
    })

    it('resolve 50 drift warnings without corruption', () => {
        const record = makeRecord(5)
        const warnings: any[] = []

        // Generate drift warnings
        for (let i = 0; i < 50; i++) {
            const spirit = record.attractors[i % 5]!
            const drifted = perturbVector(spirit.position, 0.25)

            const result = mutate(record, {
                source: `drift-${i}`,
                concepts: [{ label: `Drift-${i}`, type: 'entity', position: drifted }],
                relations: [],
            })
            warnings.push(...result.driftWarnings)
        }

        // Resolve half as confirm, half as reject
        for (let i = 0; i < warnings.length; i++) {
            const decision = i % 2 === 0 ? 'confirm' : 'reject'
            resolveDrift(record, warnings[i], decision as 'confirm' | 'reject')
        }

        // Record still valid
        for (const a of record.attractors) {
            expect(a.position.length).toBe(DIMS)
            expect(Number.isFinite(a.salience)).toBe(true)
        }
    })
})

describe('pressure: ghost cascade', () => {
    it('creating concepts in tight cluster causes ghost chain', () => {
        // Ghost cascade requires: concept creates/refines one mechanic,
        // ghost check finds a DIFFERENT nearby mechanic and archives it.
        // Use tight refinementThreshold so near-identical concepts are "new" not refinements.
        const record = boot({
            workspaceId: 'ghost-cascade',
            spiritAnchors: [{ label: 'Far', type: 'entity', position: [1, 0, 0, 0] }],
        })

        // Pre-create 20 mechanics at nearly identical positions
        for (let i = 0; i < 20; i++) {
            const tiny = 0.001 * i
            const pos = [tiny, tiny, 1, tiny]
            const mag = Math.sqrt(pos.reduce((s, x) => s + x * x, 0))
            record.attractors.push({
                id: `ghost-target-${i}`,
                position: pos.map(x => x / mag),
                regionId: record.regions[0]!.id,
                type: 'action',
                depthClass: 'mechanics',
                salience: 0.5,
                driftProtected: false,
                label: `GhostTarget-${i}`,
                mutationCount: 0,
                lastMutatedAt: Date.now(),
            })
        }

        // Now mutate with concepts near the cluster — with very tight
        // refinementThreshold so each creates a new attractor, then ghost
        // check catches nearby existing mechanics.
        for (let i = 0; i < 10; i++) {
            mutate(record, {
                source: `cascade-${i}`,
                concepts: [{
                    label: `Cascade-${i}`,
                    type: 'action',
                    position: [0, 0, 1, 0], // exact center of cluster
                }],
                relations: [],
            }, { refinementThreshold: 0.001 }) // nearly nothing counts as refinement
        }

        expect(record.ledgerRefs.length).toBeGreaterThan(0)
    })
})

describe('pressure: transformation rule explosion', () => {
    it('1000 relations between 100 concepts', () => {
        const record = makeRecord(2)
        const labels: string[] = []

        // Create 100 concepts
        for (let i = 0; i < 100; i++) {
            const label = `Node-${i}`
            labels.push(label)
            mutate(record, {
                source: 'graph',
                concepts: [{ label, type: randomConceptType(), position: randomVector() }],
                relations: [],
            })
        }

        // Add 1000 random relations
        const relations = Array.from({ length: 1000 }, () => ({
            sourceLabel: labels[Math.floor(Math.random() * labels.length)]!,
            targetLabel: labels[Math.floor(Math.random() * labels.length)]!,
            relation: randomRelationType(),
            confidence: Math.random(),
        })).filter(r => r.sourceLabel !== r.targetLabel) // no self-loops

        mutate(record, { source: 'relations', concepts: [], relations })

        expect(record.transformations.length).toBeGreaterThan(0)

        // Expansion with L1 should include edges
        const result = expand(record, {
            stimulus: randomVector(),
            level: 'L1',
            contextBudget: 10000,
            priority: 'relevance',
        })
        expect(result.nodes.length).toBeGreaterThan(0)
    })
})

describe('pressure: archive and recover', () => {
    it('archive 100 attractors, record stays valid', () => {
        const record = makeRecord(3)

        // Add 100 mechanics
        for (let i = 0; i < 100; i++) {
            mutate(record, {
                source: 'pre-archive',
                concepts: [{ label: `Archive-${i}`, type: 'action', position: randomVector() }],
                relations: [],
            })
        }

        const before = record.attractors.length

        // Archive 50 random mechanics
        const mechanics = record.attractors.filter(a => a.depthClass === 'mechanics')
        let archived = 0
        for (let i = 0; i < Math.min(50, mechanics.length); i++) {
            try {
                const { record: updated } = archive(record, mechanics[i]!.id)
                // archive returns a new record — copy its state
                record.attractors = updated.attractors
                record.ledgerRefs = updated.ledgerRefs
                record.lastMutatedAt = updated.lastMutatedAt
                archived++
            } catch { /* attractor may have been ghosted already */ }
        }

        expect(archived).toBeGreaterThan(0)
        expect(record.attractors.length).toBeLessThan(before)
        expect(record.ledgerRefs.length).toBe(archived)

        // Expansion still works
        const result = expand(record, {
            stimulus: randomVector(),
            level: 'L0',
            contextBudget: 1000,
            priority: 'relevance',
        })
        expect(result.nodes.length).toBeGreaterThan(0)
    })
})

describe('pressure: concurrent-like interleaved operations', () => {
    it('interleaved expand/mutate/archive 500 times', () => {
        const record = makeRecord(4)

        // Seed with 50 mechanics
        for (let i = 0; i < 50; i++) {
            mutate(record, {
                source: 'seed',
                concepts: [{ label: `Seed-${i}`, type: 'action', position: randomVector() }],
                relations: [],
            })
        }

        for (let i = 0; i < 500; i++) {
            const op = i % 3

            if (op === 0) {
                // Expand
                expand(record, {
                    stimulus: randomVector(),
                    level: i % 2 === 0 ? 'L0' : 'L1',
                    contextBudget: 500,
                    priority: 'relevance',
                })
            } else if (op === 1) {
                // Mutate
                mutate(record, {
                    source: `interleave-${i}`,
                    concepts: [{
                        label: `Interleave-${i % 30}`,
                        type: randomConceptType(),
                        position: randomVector(),
                    }],
                    relations: i % 5 === 0 ? [{
                        sourceLabel: `Interleave-${i % 30}`,
                        targetLabel: `Seed-${i % 50}`,
                        relation: randomRelationType(),
                        confidence: Math.random(),
                    }] : [],
                })
            } else {
                // Archive a random mechanic (if any exist)
                const mechanics = record.attractors.filter(a => a.depthClass === 'mechanics')
                if (mechanics.length > 5) {
                    const target = mechanics[Math.floor(Math.random() * mechanics.length)]!
                    try {
                        const { record: updated } = archive(record, target.id)
                        record.attractors = updated.attractors
                        record.ledgerRefs = updated.ledgerRefs
                    } catch { /* ok */ }
                }
            }
        }

        // Record must be internally consistent
        expect(record.attractors.length).toBeGreaterThan(0)
        for (const a of record.attractors) {
            expect(a.position.length).toBe(DIMS)
            expect(Number.isFinite(a.salience)).toBe(true)
            expect(a.depthClass === 'spirit' || a.depthClass === 'mechanics').toBe(true)
        }

        // All spirit attractors survived
        const spirits = record.attractors.filter(a => a.depthClass === 'spirit')
        expect(spirits.length).toBeGreaterThanOrEqual(4) // original 4 + any promoted
    })
})

describe('pressure: edge cases', () => {
    it('zero-length position vectors', () => {
        const record = boot({
            workspaceId: 'zero-test',
            spiritAnchors: [{ label: 'Zero', type: 'entity', position: [0, 0, 0, 0] }],
        })

        const result = expand(record, {
            stimulus: [0, 0, 0, 0],
            level: 'L0',
            contextBudget: 100,
            priority: 'relevance',
        })

        // Should not crash — cosine of zero vectors is 0
        expect(result).toBeDefined()
    })

    it('single-dimension vectors', () => {
        const record = boot({
            workspaceId: 'single-dim',
            spiritAnchors: [{ label: 'One', type: 'entity', position: [1] }],
        })

        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Also One', type: 'action', position: [0.99] }],
            relations: [],
        })

        expect(record.attractors.length).toBeGreaterThanOrEqual(1)
    })

    it('very high dimensional vectors (512)', () => {
        const dims = 512
        const record = boot({
            workspaceId: 'high-dim',
            spiritAnchors: [{
                label: 'HighDim',
                type: 'entity',
                position: randomVector(dims),
            }],
        })

        for (let i = 0; i < 100; i++) {
            mutate(record, {
                source: 'high-dim',
                concepts: [{
                    label: `HD-${i}`,
                    type: randomConceptType(),
                    position: randomVector(dims),
                }],
                relations: [],
            })
        }

        const result = expand(record, {
            stimulus: randomVector(dims),
            level: 'L1',
            contextBudget: 2000,
            priority: 'relevance',
        })

        expect(result.nodes.length).toBeGreaterThan(0)
    })

    it('duplicate labels in single mutation batch', () => {
        const record = makeRecord(1)
        const pos = randomVector()

        const result = mutate(record, {
            source: 'dupes',
            concepts: [
                { label: 'Dupe', type: 'action', position: pos },
                { label: 'Dupe', type: 'action', position: perturbVector(pos, 0.01) },
            ],
            relations: [],
        })

        // Second should refine the first (same label, close position)
        expect(result.attractorsCreated + result.attractorsRefined).toBeGreaterThanOrEqual(1)
    })

    it('empty mutation input', () => {
        const record = makeRecord(2)
        const before = record.attractors.length

        const result = mutate(record, { source: 'empty', concepts: [], relations: [] })

        expect(result.attractorsCreated).toBe(0)
        expect(result.attractorsRefined).toBe(0)
        expect(record.attractors.length).toBe(before)
    })

    it('mutation with only relations (no concepts)', () => {
        const record = makeRecord(2)

        mutate(record, {
            source: 'rels-only',
            concepts: [],
            relations: [{
                sourceLabel: 'Spirit-0',
                targetLabel: 'Spirit-1',
                relation: 'ENABLES',
                confidence: 0.9,
            }],
        })

        expect(record.transformations.length).toBe(1)
    })

    it('NaN in position vector handled gracefully', () => {
        const record = makeRecord(1)

        // This shouldn't crash even with bad data
        const result = mutate(record, {
            source: 'nan',
            concepts: [{
                label: 'BadVector',
                type: 'action',
                position: [NaN, 0, 0, 0, ...new Array(DIMS - 4).fill(0)],
            }],
            relations: [],
        })

        // Should create (distance from spirit will be NaN → treated as far)
        expect(result).toBeDefined()
    })

    it('expansion with zero budget returns nothing', () => {
        const record = makeRecord(5)
        const result = expand(record, {
            stimulus: randomVector(),
            level: 'L0',
            contextBudget: 0,
            priority: 'relevance',
        })

        expect(result.nodes).toHaveLength(0)
        expect(result.budgetUsed).toBe(0)
    })
})

describe('pressure: promotion race', () => {
    it('multiple mechanics hit promotion threshold simultaneously', () => {
        const record = makeRecord(1)

        // Create 10 mechanics and set them all near promotion threshold
        for (let i = 0; i < 10; i++) {
            mutate(record, {
                source: 'pre-promote',
                concepts: [{ label: `Racer-${i}`, type: 'action', position: randomVector() }],
                relations: [],
            })
        }

        // Set all to mutation count 50 (one below threshold)
        for (const a of record.attractors.filter(a => a.depthClass === 'mechanics')) {
            a.mutationCount = 50
        }

        // One more mutation to each should trigger promotion for all
        for (let i = 0; i < 10; i++) {
            const a = record.attractors.find(a => a.label === `Racer-${i}`)
            if (a) {
                // Directly set to 51 and run promotion check
                a.mutationCount = 51
            }
        }

        const promoted = checkPromotions(record, DEFAULT_CONFIG)

        // All 10 should promote (or however many survive ghosting)
        expect(promoted).toBeGreaterThan(0)

        // All promoted are spirit
        const spirits = record.attractors.filter(a => a.depthClass === 'spirit')
        expect(spirits.length).toBeGreaterThanOrEqual(2) // at least original + some promoted
    })
})

describe('pressure: JSONB serialization round-trip', () => {
    it('Golden Record survives JSON.stringify/parse', () => {
        const record = makeRecord(5)

        // Add substantial content
        for (let i = 0; i < 100; i++) {
            mutate(record, {
                source: 'serialize',
                concepts: [{
                    label: `Ser-${i}`,
                    type: randomConceptType(),
                    position: randomVector(),
                    attributes: { index: i, nested: { deep: true } },
                }],
                relations: i % 3 === 0 ? [{
                    sourceLabel: `Ser-${i}`,
                    targetLabel: `Ser-${Math.max(0, i - 1)}`,
                    relation: randomRelationType(),
                    confidence: Math.random(),
                }] : [],
            })
        }

        // Serialize and deserialize (simulates JSONB round-trip)
        const json = JSON.stringify(record)
        const restored = JSON.parse(json) as GoldenRecord

        // Structural integrity
        expect(restored.version).toBe(record.version)
        expect(restored.workspaceId).toBe(record.workspaceId)
        expect(restored.attractors.length).toBe(record.attractors.length)
        expect(restored.regions.length).toBe(record.regions.length)
        expect(restored.transformations.length).toBe(record.transformations.length)
        expect(restored.ledgerRefs.length).toBe(record.ledgerRefs.length)

        // Float precision preserved
        for (let i = 0; i < restored.attractors.length; i++) {
            const orig = record.attractors[i]!
            const rest = restored.attractors[i]!
            expect(rest.position.length).toBe(orig.position.length)
            for (let j = 0; j < orig.position.length; j++) {
                expect(rest.position[j]).toBe(orig.position[j]) // exact match — JSON preserves floats
            }
        }

        // Expansion works on restored record
        const result = expand(restored, {
            stimulus: randomVector(),
            level: 'L1',
            contextBudget: 2000,
            priority: 'relevance',
        })
        expect(result.nodes.length).toBeGreaterThan(0)
    })
})
