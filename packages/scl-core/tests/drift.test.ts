import { describe, it, expect } from 'vitest'
import { boot } from '../src/boot.js'
import { mutate } from '../src/mutate.js'
import { resolveDrift } from '../src/drift.js'
import { V_IDENTITY, V_OPERATOR, V_IDENTITY_DRIFT, TEST_WORKSPACE } from './fixtures/vectors.js'

describe('resolveDrift', () => {
    it('confirm applies the held mutation', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'Identity', type: 'entity', position: V_IDENTITY },
            ],
        })

        const originalPos = [...record.attractors[0]!.position]

        // Trigger drift warning
        const result = mutate(record, {
            source: 'test',
            concepts: [{ label: 'Drifted', type: 'entity', position: V_IDENTITY_DRIFT }],
            relations: [],
        })

        expect(result.driftWarnings).toHaveLength(1)
        const warning = result.driftWarnings[0]!

        // Position unchanged before resolution
        expect(record.attractors[0]!.position).toEqual(originalPos)

        // Confirm drift
        const resolved = resolveDrift(record, warning, 'confirm')

        // Position should now be blended
        const a = resolved.attractors[0]!
        expect(a.position).not.toEqual(originalPos)
        expect(a.mutationCount).toBe(1)
        expect(warning.status).toBe('confirmed')
    })

    it('reject leaves attractor unchanged', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'Identity', type: 'entity', position: V_IDENTITY },
            ],
        })

        const originalPos = [...record.attractors[0]!.position]

        const result = mutate(record, {
            source: 'test',
            concepts: [{ label: 'Drifted', type: 'entity', position: V_IDENTITY_DRIFT }],
            relations: [],
        })

        const warning = result.driftWarnings[0]!
        const resolved = resolveDrift(record, warning, 'reject')

        expect(resolved.attractors[0]!.position).toEqual(originalPos)
        expect(resolved.attractors[0]!.mutationCount).toBe(0)
        expect(warning.status).toBe('rejected')
    })

    it('updates lastMutatedAt on confirm', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })

        const result = mutate(record, {
            source: 'test',
            concepts: [{ label: 'Drifted', type: 'entity', position: V_IDENTITY_DRIFT }],
            relations: [],
        })

        const before = record.lastMutatedAt
        const resolved = resolveDrift(record, result.driftWarnings[0]!, 'confirm')

        expect(resolved.lastMutatedAt).toBeGreaterThanOrEqual(before)
    })

    it('respects custom refinement weights', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })

        const result = mutate(record, {
            source: 'test',
            concepts: [{ label: 'Drifted', type: 'entity', position: V_IDENTITY_DRIFT }],
            relations: [],
        })

        const warning = result.driftWarnings[0]!
        const resolved = resolveDrift(record, warning, 'confirm', {
            refinementWeightIncoming: 0.1,
        })

        // With baseIncoming=0.1 and mutationCount=0, adaptiveIncoming = 0.1/√1 = 0.1
        // V_IDENTITY=[1,0,0,0], V_IDENTITY_DRIFT=[0.8,0.3,0.3,0.3]
        // Blended: [1*0.9 + 0.8*0.1, ...] = [0.98, 0.03, 0.03, 0.03]
        const a = resolved.attractors[0]!
        expect(a.position[0]).toBeCloseTo(0.98, 1)
    })

    it('confirmed drift on mature spirit uses Robbins-Monro weight (weaker than fresh)', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })

        // Simulate a mature spirit anchor (99 prior refinements)
        record.attractors[0]!.mutationCount = 99

        const result = mutate(record, {
            source: 'test',
            concepts: [{ label: 'Drifted', type: 'entity', position: V_IDENTITY_DRIFT }],
            relations: [],
        })

        expect(result.driftWarnings).toHaveLength(1)
        const warning = result.driftWarnings[0]!

        // Confirm drift — mature spirit (mutationCount=99) gets adaptive weight:
        //   adaptiveIncoming = 0.3 / √100 = 0.03
        // V_IDENTITY=[1,0,0,0], V_IDENTITY_DRIFT=[0.8,0.3,0.3,0.3]
        // Blended dim 0: 1.0 * 0.97 + 0.8 * 0.03 = 0.994
        // Compare: fresh spirit (mutationCount=0) would get dim 0 = 0.7 + 0.24 = 0.94
        const resolved = resolveDrift(record, warning, 'confirm')
        const a = resolved.attractors[0]!

        // Much closer to original 1.0 than the 0.94 a fresh spirit would receive
        expect(a.position[0]).toBeGreaterThan(0.98)
        expect(a.mutationCount).toBe(100)
        expect(warning.status).toBe('confirmed')
    })
})
