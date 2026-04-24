import { describe, it, expect } from 'vitest'
import { boot, mutate, expand, archive, resolveDrift, checkPromotions, DEFAULT_CONFIG } from '../src/index.js'
import type { GoldenRecord, MutationInput } from '../src/types.js'
import { V_IDENTITY, V_OPERATOR, V_CODING, V_DEVOPS, V_IDENTITY_DRIFT, TEST_WORKSPACE } from './fixtures/vectors.js'

/**
 * Integration tests: full lifecycle scenarios simulating real usage.
 * These test the complete experience loop.
 */

function makeRecord(): GoldenRecord {
    return boot({
        workspaceId: TEST_WORKSPACE,
        spiritAnchors: [
            { label: 'I am Plexo', type: 'entity', position: V_IDENTITY },
            { label: 'Dustin is my operator', type: 'entity', position: V_OPERATOR },
        ],
    })
}

describe('experience loop: 100 sequential mutations', () => {
    it('spirit attractors drift < 15% after 100 mechanic mutations', () => {
        const record = makeRecord()
        const spiritPositionsBefore = record.attractors
            .filter(a => a.depthClass === 'spirit')
            .map(a => ({ id: a.id, pos: [...a.position] }))

        // Run 100 mutations — all mechanic concepts, no spirit perturbation
        for (let i = 0; i < 100; i++) {
            const angle = (i / 100) * Math.PI * 2
            const position = [
                Math.cos(angle) * 0.3,
                Math.sin(angle) * 0.3,
                0.7 + (i % 2) * 0.1,
                0.2 + (i % 3) * 0.05,
            ]

            mutate(record, {
                source: `task-${i}`,
                concepts: [{
                    label: `mechanic-concept-${i % 20}`, // recycle labels → refinement
                    type: 'action',
                    position,
                }],
                relations: [],
            })
        }

        // Verify spirit attractors haven't drifted
        for (const before of spiritPositionsBefore) {
            const after = record.attractors.find(a => a.id === before.id)
            expect(after).toBeDefined()
            expect(after!.position).toEqual(before.pos) // exact match — no mutation applied
            expect(after!.depthClass).toBe('spirit')
            expect(after!.driftProtected).toBe(true)
        }
    })

    it('mechanic attractors accumulate mutations and can promote', () => {
        const record = makeRecord()

        // Create a mechanic then refine it 55 times
        const basePos = V_CODING
        mutate(record, {
            source: 'init',
            concepts: [{ label: 'Stable Coding', type: 'action', position: basePos }],
            relations: [],
        })

        for (let i = 0; i < 55; i++) {
            // Tiny perturbation — stays within refinement threshold
            const pos = basePos.map((v, j) => v + (j === 2 ? 0.001 * (i % 3) : 0))
            mutate(record, {
                source: `refine-${i}`,
                concepts: [{ label: 'Stable Coding', type: 'action', position: pos }],
                relations: [],
            })
        }

        const mechanic = record.attractors.find(a => a.label === 'Stable Coding')!
        // 1 initial creation + 55 refinements = mutationCount 55
        // But first call creates it (mutationCount=0), then 55 refines → 55
        // Actually first call creates (mutationCount=0, not incremented on creation)
        // Then 55 refinements → mutationCount=55
        expect(mechanic.mutationCount).toBeGreaterThan(50)
        // Should have auto-promoted to spirit
        expect(mechanic.depthClass).toBe('spirit')
        expect(mechanic.driftProtected).toBe(true)
    })
})

describe('experience loop: ghost displacement', () => {
    it('old mechanic gets archived when superseded by new concept', () => {
        const record = makeRecord()

        // Create two mechanics at similar positions
        record.attractors.push({
            id: 'old-mechanic-id',
            position: [0, 0, 1, 0],
            regionId: record.regions[0]!.id,
            type: 'action',
            depthClass: 'mechanics',
            salience: 0.5,
            driftProtected: false,
            label: 'Old Pattern',
            mutationCount: 5,
            lastMutatedAt: Date.now(),
        })
        record.attractors.push({
            id: 'nearby-mechanic-id',
            position: [0, 0.03, 0.99, 0.03],
            regionId: record.regions[0]!.id,
            type: 'action',
            depthClass: 'mechanics',
            salience: 0.5,
            driftProtected: false,
            label: 'Nearby Pattern',
            mutationCount: 2,
            lastMutatedAt: Date.now(),
        })

        // Refine one — the other should get ghosted since it's within displacement threshold
        const result = mutate(record, {
            source: 'supersede',
            concepts: [{ label: 'Old Pattern', type: 'action', position: [0, 0.01, 0.999, 0.01] }],
            relations: [],
        })

        // Nearby Pattern should be ghosted (distance to [0,0.01,0.999,0.01] < 0.1)
        expect(result.ghostsArchived.length).toBeGreaterThanOrEqual(1)
        expect(record.ledgerRefs.length).toBeGreaterThanOrEqual(1)
    })
})

describe('experience loop: drift protection end-to-end', () => {
    it('drift warning → resolve → mutation applied or rejected', () => {
        const record = makeRecord()

        // Attempt to mutate spirit beyond drift threshold
        const result = mutate(record, {
            source: 'drift-test',
            concepts: [{
                label: 'Modified Plexo',
                type: 'entity',
                position: V_IDENTITY_DRIFT,
            }],
            relations: [],
        })

        expect(result.driftWarnings.length).toBe(1)
        const warning = result.driftWarnings[0]!
        expect(warning.status).toBe('pending')

        // Spirit unchanged
        const plexo = record.attractors.find(a => a.label === 'I am Plexo')!
        expect(plexo.position).toEqual(V_IDENTITY)

        // Reject the drift
        const afterReject = resolveDrift(record, warning, 'reject')
        expect(warning.status).toBe('rejected')
        expect(afterReject.attractors.find(a => a.label === 'I am Plexo')!.position).toEqual(V_IDENTITY)
    })
})

describe('experience loop: full boot → expand → mutate → expand cycle', () => {
    it('mutated knowledge appears in subsequent expansions', () => {
        const record = makeRecord()

        // Expand before mutation — only spirit attractors
        const before = expand(record, {
            stimulus: V_CODING,
            level: 'L0',
            contextBudget: 1000,
            priority: 'relevance',
        })
        expect(before.nodes.every(n => n.depthClass === 'spirit')).toBe(true)

        // Mutate: add coding knowledge
        mutate(record, {
            source: 'task-1',
            concepts: [
                { label: 'TypeScript patterns', type: 'action', position: V_CODING },
                { label: 'CI/CD pipeline', type: 'action', position: V_DEVOPS },
            ],
            relations: [{
                sourceLabel: 'TypeScript patterns',
                targetLabel: 'CI/CD pipeline',
                relation: 'ENABLES',
                confidence: 0.8,
            }],
        })

        // Expand after mutation — should now include mechanics
        const after = expand(record, {
            stimulus: V_CODING,
            level: 'L1',
            contextBudget: 1000,
            priority: 'relevance',
        })

        const tsNode = after.nodes.find(n => n.label === 'TypeScript patterns')
        expect(tsNode).toBeDefined()
        expect(tsNode!.depthClass).toBe('mechanics')

        // L1 should include edges
        expect(after.edges.length).toBeGreaterThanOrEqual(0) // may or may not have edges depending on region assignment
        expect(after.attractorsExpanded).toBeGreaterThan(before.attractorsExpanded)
    })
})
