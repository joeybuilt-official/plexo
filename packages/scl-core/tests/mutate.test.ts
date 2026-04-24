import { describe, it, expect } from 'vitest'
import { boot } from '../src/boot.js'
import { mutate } from '../src/mutate.js'
import { generateId } from '../src/utils/id.js'
import type { GoldenRecord, MutationInput } from '../src/types.js'
import {
    V_IDENTITY, V_OPERATOR, V_CODING, V_DEVOPS,
    V_IDENTITY_CLOSE, V_IDENTITY_DRIFT, V_CODING_DEVOPS,
    V_OPERATOR_CLOSE, TEST_WORKSPACE,
} from './fixtures/vectors.js'

function makeRecord(): GoldenRecord {
    return boot({
        workspaceId: TEST_WORKSPACE,
        spiritAnchors: [
            { label: 'Identity', type: 'entity', position: V_IDENTITY },
            { label: 'Operator', type: 'entity', position: V_OPERATOR },
        ],
    })
}

describe('mutate: refinement', () => {
    it('refines existing attractor when concept is close', () => {
        const record = makeRecord()
        const input: MutationInput = {
            source: 'test',
            concepts: [
                { label: 'Identity Update', type: 'entity', position: V_IDENTITY_CLOSE },
            ],
            relations: [],
        }

        const result = mutate(record, input)

        expect(result.attractorsRefined).toBe(1)
        expect(result.attractorsCreated).toBe(0)
        expect(record.attractors[0]!.mutationCount).toBe(1)
    })

    it('applies weighted average to position', () => {
        const record = makeRecord()
        const oldPos = [...record.attractors[0]!.position]

        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Near Identity', type: 'entity', position: V_IDENTITY_CLOSE }],
            relations: [],
        })

        const newPos = record.attractors[0]!.position
        // Position should be blended (0.7 * old + 0.3 * new)
        for (let i = 0; i < oldPos.length; i++) {
            const expected = oldPos[i]! * 0.7 + V_IDENTITY_CLOSE[i]! * 0.3
            expect(newPos[i]).toBeCloseTo(expected, 5)
        }
    })

    it('increments mutationCount on each refinement', () => {
        const record = makeRecord()
        const input: MutationInput = {
            source: 'test',
            concepts: [{ label: 'Near', type: 'entity', position: V_IDENTITY_CLOSE }],
            relations: [],
        }

        mutate(record, input)
        mutate(record, input)
        mutate(record, input)

        expect(record.attractors[0]!.mutationCount).toBe(3)
    })

    it('merges attributes on refinement', () => {
        const record = makeRecord()
        record.attractors[0]!.attributes = { a: 1 }

        mutate(record, {
            source: 'test',
            concepts: [{
                label: 'Near', type: 'entity', position: V_IDENTITY_CLOSE,
                attributes: { b: 2 },
            }],
            relations: [],
        })

        expect(record.attractors[0]!.attributes).toEqual({ a: 1, b: 2 })
    })
})

describe('mutate: creation', () => {
    it('creates new attractor when concept is far from all', () => {
        const record = makeRecord()
        const result = mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })

        expect(result.attractorsCreated).toBe(1)
        expect(result.attractorsRefined).toBe(0)
        expect(record.attractors).toHaveLength(3) // 2 spirit + 1 new
    })

    it('creates new attractors as mechanics', () => {
        const record = makeRecord()
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'New Concept', type: 'action', position: V_CODING }],
            relations: [],
        })

        const newAttractor = record.attractors.find(a => a.label === 'New Concept')!
        expect(newAttractor.depthClass).toBe('mechanics')
        expect(newAttractor.driftProtected).toBe(false)
        expect(newAttractor.salience).toBe(0.5)
    })

    it('assigns new attractors to closest region', () => {
        const record = makeRecord()
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'New', type: 'action', position: V_CODING }],
            relations: [],
        })

        const newAttractor = record.attractors.find(a => a.label === 'New')!
        expect(newAttractor.regionId).toBe(record.regions[0]!.id) // only one region
    })

    it('creates multiple concepts in one mutation', () => {
        const record = makeRecord()
        const result = mutate(record, {
            source: 'test',
            concepts: [
                { label: 'C1', type: 'action', position: V_CODING },
                { label: 'C2', type: 'action', position: V_DEVOPS },
            ],
            relations: [],
        })

        expect(result.attractorsCreated).toBe(2)
        expect(record.attractors).toHaveLength(4)
    })
})

describe('mutate: ghost check', () => {
    it('archives mechanic when nearby concept supersedes it', () => {
        // Ghost scenario: two mechanics close together. A concept refines one,
        // and the ghost check archives the other (within ghostDisplacementThreshold).
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'Identity', type: 'entity', position: V_IDENTITY },
            ],
        })

        // Add two mechanics very close to each other
        record.attractors.push({
            id: generateId(),
            position: [0, 0, 1, 0],
            regionId: record.regions[0]!.id,
            type: 'action' as const,
            depthClass: 'mechanics' as const,
            salience: 0.5,
            driftProtected: false,
            label: 'Old Coding',
            mutationCount: 0,
            lastMutatedAt: Date.now(),
        })
        record.attractors.push({
            id: generateId(),
            position: [0, 0.05, 0.99, 0.05],
            regionId: record.regions[0]!.id,
            type: 'action' as const,
            depthClass: 'mechanics' as const,
            salience: 0.5,
            driftProtected: false,
            label: 'Coding v2',
            mutationCount: 0,
            lastMutatedAt: Date.now(),
        })

        // Mutate with a concept very close to both.
        // It refines whichever is nearest. Ghost check then finds the OTHER
        // mechanic within ghostDisplacementThreshold and archives it.
        const result = mutate(record, {
            source: 'test',
            concepts: [{ label: 'Updated Coding', type: 'action', position: [0, 0.02, 0.998, 0.02] }],
            relations: [],
        })

        expect(result.ghostsArchived).toHaveLength(1)
        expect(record.ledgerRefs.length).toBeGreaterThanOrEqual(1)
        // One of the two mechanics should be archived
        const archivedLabel = result.ghostsArchived[0]!.ghostLabel
        expect(['Old Coding', 'Coding v2']).toContain(archivedLabel)
    })

    it('does not ghost-archive spirit attractors', () => {
        const record = makeRecord()
        // Try to displace Identity (spirit) with very close concept
        const veryClose = [0.999, 0.001, 0.001, 0.001]

        const result = mutate(record, {
            source: 'test',
            concepts: [{ label: 'Identity Clone', type: 'entity', position: veryClose }],
            relations: [],
        })

        // Should refine, not ghost-archive (spirit is drift-protected)
        expect(result.ghostsArchived).toHaveLength(0)
        // Identity should still exist
        expect(record.attractors.find(a => a.label === 'Identity')).toBeDefined()
    })
})

describe('mutate: adaptive refinement weight', () => {
    it('first mutation uses the configured default weight (Robbins-Monro: 0.3/sqrt(1) = 0.3)', () => {
        const record = makeRecord()
        const oldPos = [...record.attractors[0]!.position]

        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Near Identity', type: 'entity', position: V_IDENTITY_CLOSE }],
            relations: [],
        })

        // mutationCount was 0 → adaptiveIncoming = 0.3/sqrt(1) = 0.3 (unchanged)
        const newPos = record.attractors[0]!.position
        for (let i = 0; i < oldPos.length; i++) {
            const expected = oldPos[i]! * 0.7 + V_IDENTITY_CLOSE[i]! * 0.3
            expect(newPos[i]).toBeCloseTo(expected, 5)
        }
    })

    it('established attractor (mutationCount=8) blends at decayed weight 0.3/sqrt(9)=0.1', () => {
        const record = makeRecord()
        // Fast-forward: attractor has been refined 8 times already
        record.attractors[0]!.mutationCount = 8
        const posBeforeNinth = [...record.attractors[0]!.position]

        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Near Identity', type: 'entity', position: V_IDENTITY_CLOSE }],
            relations: [],
        })

        // adaptiveIncoming = 0.3 / sqrt(8 + 1) = 0.3 / 3 = 0.1
        const adaptiveIncoming = 0.3 / Math.sqrt(9)
        const adaptiveExisting = 1 - adaptiveIncoming
        const newPos = record.attractors[0]!.position
        for (let i = 0; i < posBeforeNinth.length; i++) {
            const expected = posBeforeNinth[i]! * adaptiveExisting + V_IDENTITY_CLOSE[i]! * adaptiveIncoming
            expect(newPos[i]).toBeCloseTo(expected, 5)
        }

        // Incoming weight must be well below the default 0.3
        expect(adaptiveIncoming).toBeCloseTo(0.1, 5)
    })

    it('adaptation: incoming weight halves at mutationCount=3 relative to first mutation', () => {
        // At n=0: weight = 0.3/1 = 0.3
        // At n=3: weight = 0.3/2 = 0.15  (half)
        const wAt0 = 0.3 / Math.sqrt(1)
        const wAt3 = 0.3 / Math.sqrt(4)
        expect(wAt3).toBeCloseTo(wAt0 / 2, 5)
    })
})

describe('mutate: drift warning', () => {
    it('warns when spirit mutation exceeds drift threshold', () => {
        const record = makeRecord()

        const result = mutate(record, {
            source: 'test',
            concepts: [
                { label: 'Drifted Identity', type: 'entity', position: V_IDENTITY_DRIFT },
            ],
            relations: [],
        })

        expect(result.driftWarnings).toHaveLength(1)
        expect(result.driftWarnings[0]!.attractorLabel).toBe('Identity')
        expect(result.driftWarnings[0]!.status).toBe('pending')
        expect(result.driftWarnings[0]!.semanticDistance).toBeGreaterThan(0.15)
    })

    it('does NOT apply mutation when drift warning fires', () => {
        const record = makeRecord()
        const originalPos = [...record.attractors[0]!.position]

        mutate(record, {
            source: 'test',
            concepts: [
                { label: 'Drifted', type: 'entity', position: V_IDENTITY_DRIFT },
            ],
            relations: [],
        })

        // Position should be unchanged
        expect(record.attractors[0]!.position).toEqual(originalPos)
        expect(record.attractors[0]!.mutationCount).toBe(0)
    })

    it('does not warn when spirit mutation is within threshold', () => {
        const record = makeRecord()

        const result = mutate(record, {
            source: 'test',
            concepts: [
                { label: 'Close Identity', type: 'entity', position: V_IDENTITY_CLOSE },
            ],
            relations: [],
        })

        expect(result.driftWarnings).toHaveLength(0)
        expect(result.attractorsRefined).toBe(1)
    })
})

describe('mutate: relations', () => {
    it('creates transformation rules from relations', () => {
        const record = makeRecord()
        // Add a mechanic first
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })

        const result = mutate(record, {
            source: 'test',
            concepts: [],
            relations: [{
                sourceLabel: 'Identity',
                targetLabel: 'Coding',
                relation: 'PERFORMS',
                confidence: 0.9,
            }],
        })

        expect(result.rulesAdded).toBe(1)
        expect(record.transformations).toHaveLength(1)
        expect(record.transformations[0]!.relationType).toBe('PERFORMS')
    })

    it('refines existing rules on repeated relations', () => {
        const record = makeRecord()
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })

        mutate(record, {
            source: 'test',
            concepts: [],
            relations: [{
                sourceLabel: 'Identity', targetLabel: 'Coding',
                relation: 'PERFORMS', confidence: 0.9,
            }],
        })

        const result = mutate(record, {
            source: 'test',
            concepts: [],
            relations: [{
                sourceLabel: 'Identity', targetLabel: 'Coding',
                relation: 'PERFORMS', confidence: 1.0,
            }],
        })

        expect(result.rulesRefined).toBe(1)
        expect(record.transformations).toHaveLength(1)
        // Confidence should be blended
        expect(record.transformations[0]!.confidence).toBeGreaterThan(0.9)
    })

    it('skips relations with unknown labels', () => {
        const record = makeRecord()
        const result = mutate(record, {
            source: 'test',
            concepts: [],
            relations: [{
                sourceLabel: 'Unknown', targetLabel: 'Also Unknown',
                relation: 'IS_A', confidence: 0.5,
            }],
        })

        expect(result.rulesAdded).toBe(0)
        expect(record.transformations).toHaveLength(0)
    })
})

describe('mutate: mixed operations', () => {
    it('handles concepts and relations in single mutation', () => {
        const record = makeRecord()
        const result = mutate(record, {
            source: 'test',
            concepts: [
                { label: 'Coding', type: 'action', position: V_CODING },
                { label: 'DevOps', type: 'action', position: V_DEVOPS },
            ],
            relations: [{
                sourceLabel: 'Coding', targetLabel: 'DevOps',
                relation: 'ENABLES', confidence: 0.8,
            }],
        })

        expect(result.attractorsCreated).toBe(2)
        expect(result.rulesAdded).toBe(1)
    })

    it('updates lastMutatedAt on record', () => {
        const record = makeRecord()
        const before = record.lastMutatedAt

        // Small delay to ensure timestamp differs
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'New', type: 'action', position: V_CODING }],
            relations: [],
        })

        expect(record.lastMutatedAt).toBeGreaterThanOrEqual(before)
    })
})

describe('mutate: region centroid and density update', () => {
    it('updates region centroid when a new attractor is created', () => {
        // Boot: 2 spirit anchors at V_IDENTITY=[1,0,0,0] and V_OPERATOR=[0,1,0,0]
        // centroid = [0.5, 0.5, 0, 0]
        const record = makeRecord()
        const initialCentroid = [...record.regions[0]!.centroid]

        // Add mechanic far from spirits → centroid shifts toward V_CODING
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })

        const updated = record.regions[0]!.centroid
        expect(updated).not.toEqual(initialCentroid)
        // centroid([1,0,0,0], [0,1,0,0], [0,0,1,0]) ≈ [0.333, 0.333, 0.333, 0]
        expect(updated[2]).toBeCloseTo(1 / 3, 3)
    })

    it('increments region density when an attractor is created', () => {
        const record = makeRecord() // 2 spirit attractors → density=2
        const initialDensity = record.regions[0]!.density

        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })

        expect(record.regions[0]!.density).toBe(initialDensity + 1)
    })

    it('decrements region density when a mechanic is ghosted', () => {
        // Deterministic ghost scenario:
        //   - 'Old Coding' at [0,0,1,0] — exactly hit by incoming concept → refined
        //   - 'Old Neighbor' at [0,0.001,0.9999,0.001] — trivially close → ghosted
        // Old Coding is distance=0 from incoming, so it is unambiguously nearest.
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })
        record.attractors.push({
            id: 'gc-target',
            position: [0, 0, 1, 0],
            regionId: record.regions[0]!.id,
            type: 'action' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, label: 'Old Coding',
            mutationCount: 0, lastMutatedAt: Date.now(),
        })
        record.attractors.push({
            id: 'gc-neighbor',
            position: [0, 0.001, 0.9999, 0.001],
            regionId: record.regions[0]!.id,
            type: 'action' as const, depthClass: 'mechanics' as const,
            salience: 0.5, driftProtected: false, label: 'Old Neighbor',
            mutationCount: 0, lastMutatedAt: Date.now(),
        })
        // 3 attractors in root region; boot density=1 (set before pushes)

        // Exact-same position as Old Coding → distance=0, unambiguously refined.
        // Ghost check then archives Old Neighbor (distance < 0.1 from concept position).
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'New Coding', type: 'action', position: [0, 0, 1, 0] }],
            relations: [],
        })

        // Old Neighbor must be ghosted
        expect(record.attractors.find(a => a.id === 'gc-neighbor')).toBeUndefined()
        // Density updated: 1 spirit + 1 refined mechanic = 2
        expect(record.regions[0]!.density).toBe(2)
    })

    it('updates centroid when an attractor position is refined', () => {
        const record = makeRecord()
        // Add a mechanic at V_CODING
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })
        const centroidAfterCreate = [...record.regions[0]!.centroid]

        // Refine the mechanic toward V_DEVOPS (close enough for refinement but shifts centroid)
        // Blend: 0.3 incoming weight at mutationCount=0
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING_DEVOPS }],
            relations: [],
        })

        const centroidAfterRefine = record.regions[0]!.centroid
        expect(centroidAfterRefine).not.toEqual(centroidAfterCreate)
    })
})
