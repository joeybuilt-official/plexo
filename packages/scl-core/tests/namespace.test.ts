import { describe, it, expect } from 'vitest'
import { boot, mutate, expand } from '../src/index.js'
import type { GoldenRecord, MutationInput } from '../src/types.js'
import { V_IDENTITY, V_CODING, V_DEVOPS, TEST_WORKSPACE } from './fixtures/vectors.js'

/**
 * Namespace isolation tests.
 * Validates that cross-app knowledge sharing works correctly.
 */

function makeRecord(): GoldenRecord {
    const record = boot({
        workspaceId: TEST_WORKSPACE,
        spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
    })
    // Tag root region as core namespace
    record.regions[0]!.namespace = 'core'
    return record
}

describe('namespace isolation', () => {
    it('app A writes attractor, app B can read via expansion', () => {
        const record = makeRecord()

        // App A writes
        mutate(record, {
            source: 'fylo',
            concepts: [{ label: 'Receipt Processing', type: 'action', position: V_CODING }],
            relations: [],
        })

        // Tag the new attractor's region with fylo namespace
        const receipt = record.attractors.find(a => a.label === 'Receipt Processing')!
        const region = record.regions.find(r => r.id === receipt.regionId)!
        region.namespace = 'fylo'

        // App B (or core) can read via expansion
        const result = expand(record, {
            stimulus: V_CODING,
            level: 'L0',
            contextBudget: 1000,
            priority: 'relevance',
        })

        const found = result.nodes.find(n => n.label === 'Receipt Processing')
        expect(found).toBeDefined()
    })

    it('namespaced mutations create tagged attractors', () => {
        const record = makeRecord()

        mutate(record, {
            source: 'levio',
            concepts: [
                { label: 'Customer Segment', type: 'entity', position: V_CODING },
                { label: 'Revenue Forecast', type: 'quantity', position: V_DEVOPS },
            ],
            relations: [],
        })

        // Both new attractors assigned to root region initially
        expect(record.attractors).toHaveLength(3) // 1 spirit + 2 new
        // New attractors are mechanics
        const newAttractors = record.attractors.filter(a => a.depthClass === 'mechanics')
        expect(newAttractors).toHaveLength(2)
    })

    it('namespace A mutation does not affect namespace B attractors', () => {
        const record = makeRecord()

        // Create mechanic in "fylo" context
        mutate(record, {
            source: 'fylo',
            concepts: [{ label: 'Fylo Concept', type: 'action', position: V_CODING }],
            relations: [],
        })
        const fyloConcept = record.attractors.find(a => a.label === 'Fylo Concept')!
        const initialPos = [...fyloConcept.position]

        // Create mechanic in "levio" context at different position
        mutate(record, {
            source: 'levio',
            concepts: [{ label: 'Levio Concept', type: 'action', position: V_DEVOPS }],
            relations: [],
        })

        // Fylo concept unchanged
        expect(fyloConcept.position).toEqual(initialPos)
        expect(record.attractors.find(a => a.label === 'Levio Concept')).toBeDefined()
    })

    it('ghost archival produces valid LedgerPointer', () => {
        const record = makeRecord()

        // Set up two close mechanics, ghost one
        record.attractors.push({
            id: 'old-a',
            position: [0, 0, 1, 0],
            regionId: record.regions[0]!.id,
            type: 'action',
            depthClass: 'mechanics',
            salience: 0.5,
            driftProtected: false,
            label: 'Old A',
            mutationCount: 0,
            lastMutatedAt: Date.now(),
        })
        record.attractors.push({
            id: 'old-b',
            position: [0, 0.02, 0.99, 0.02],
            regionId: record.regions[0]!.id,
            type: 'action',
            depthClass: 'mechanics',
            salience: 0.5,
            driftProtected: false,
            label: 'Old B',
            mutationCount: 0,
            lastMutatedAt: Date.now(),
        })

        const result = mutate(record, {
            source: 'ghost-test',
            concepts: [{ label: 'Old A', type: 'action', position: [0, 0.01, 0.999, 0.01] }],
            relations: [],
        })

        // Old B should be ghosted (close to refined Old A position)
        expect(result.ghostsArchived.length).toBeGreaterThanOrEqual(1)
        const pointer = result.ghostsArchived[0]!
        expect(pointer.ghostLabel).toBeTruthy()
        expect(pointer.positionAtArchival).toHaveLength(4)
        expect(pointer.archivedAt).toBeGreaterThan(0)
        expect(pointer.externalRef).toBeTruthy()

        // LedgerPointer stored on record
        expect(record.ledgerRefs.length).toBeGreaterThanOrEqual(1)
    })

    it('expansion returns empty when scl has no attractors', () => {
        const record = boot({ workspaceId: TEST_WORKSPACE, spiritAnchors: [] })

        const result = expand(record, {
            stimulus: V_CODING,
            level: 'L0',
            contextBudget: 1000,
            priority: 'relevance',
        })

        expect(result.nodes).toHaveLength(0)
        expect(result.attractorsExpanded).toBe(0)
    })
})
