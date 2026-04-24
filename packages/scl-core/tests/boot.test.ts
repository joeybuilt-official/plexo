import { describe, it, expect } from 'vitest'
import { boot } from '../src/boot.js'
import { V_IDENTITY, V_OPERATOR, V_CODING, TEST_WORKSPACE } from './fixtures/vectors.js'

describe('boot', () => {
    it('creates a valid GoldenRecord', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'I am Plexo', type: 'entity', position: V_IDENTITY },
            ],
        })

        expect(record.version).toBe('scl/1.0')
        expect(record.workspaceId).toBe(TEST_WORKSPACE)
        expect(record.regions).toHaveLength(1)
        expect(record.attractors).toHaveLength(1)
        expect(record.transformations).toHaveLength(0)
        expect(record.ledgerRefs).toHaveLength(0)
        expect(record.bootedAt).toBeGreaterThan(0)
    })

    it('marks all anchors as spirit with drift protection', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'Identity', type: 'entity', position: V_IDENTITY },
                { label: 'Operator', type: 'entity', position: V_OPERATOR },
            ],
        })

        for (const a of record.attractors) {
            expect(a.depthClass).toBe('spirit')
            expect(a.driftProtected).toBe(true)
            expect(a.salience).toBe(1.0)
            expect(a.mutationCount).toBe(0)
        }
    })

    it('computes root region centroid from anchors', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'A', type: 'entity', position: [1, 0, 0, 0] },
                { label: 'B', type: 'entity', position: [0, 1, 0, 0] },
            ],
        })

        const root = record.regions[0]!
        expect(root.label).toBe('root')
        expect(root.centroid).toEqual([0.5, 0.5, 0, 0])
    })

    it('assigns all attractors to root region', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'A', type: 'entity', position: V_IDENTITY },
                { label: 'B', type: 'entity', position: V_OPERATOR },
                { label: 'C', type: 'entity', position: V_CODING },
            ],
        })

        const rootId = record.regions[0]!.id
        for (const a of record.attractors) {
            expect(a.regionId).toBe(rootId)
        }
    })

    it('handles empty spiritAnchors', () => {
        const record = boot({ workspaceId: TEST_WORKSPACE, spiritAnchors: [] })

        expect(record.attractors).toHaveLength(0)
        expect(record.regions).toHaveLength(1)
        expect(record.regions[0]!.centroid).toEqual([])
    })

    it('generates unique IDs', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'A', type: 'entity', position: V_IDENTITY },
                { label: 'B', type: 'entity', position: V_OPERATOR },
            ],
        })

        const ids = [record.id, record.regions[0]!.id, ...record.attractors.map(a => a.id)]
        const unique = new Set(ids)
        expect(unique.size).toBe(ids.length)
    })

    it('preserves concept types', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'Agent', type: 'entity', position: V_IDENTITY },
                { label: 'Boot', type: 'event', position: V_OPERATOR },
                { label: 'Running', type: 'state', position: V_CODING },
            ],
        })

        expect(record.attractors[0]!.type).toBe('entity')
        expect(record.attractors[1]!.type).toBe('event')
        expect(record.attractors[2]!.type).toBe('state')
    })
})
