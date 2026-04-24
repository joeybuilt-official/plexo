import { describe, it, expect } from 'vitest'
import { boot } from '../src/boot.js'
import { mutate } from '../src/mutate.js'
import { checkPromotions } from '../src/promote.js'
import { DEFAULT_CONFIG } from '../src/config.js'
import { V_IDENTITY, V_CODING, V_DEVOPS, TEST_WORKSPACE } from './fixtures/vectors.js'

describe('promote', () => {
    it('promotes mechanics attractor after enough mutations', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })

        // Add a mechanic
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })

        const mechanic = record.attractors.find(a => a.label === 'Coding')!
        expect(mechanic.depthClass).toBe('mechanics')

        // Manually set mutation count above threshold
        mechanic.mutationCount = 51

        const promoted = checkPromotions(record, DEFAULT_CONFIG)

        expect(promoted).toBe(1)
        expect(mechanic.depthClass).toBe('spirit')
        expect(mechanic.driftProtected).toBe(true)
    })

    it('does not promote if mutation count below threshold', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })

        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })

        const mechanic = record.attractors.find(a => a.label === 'Coding')!
        mechanic.mutationCount = 10

        const promoted = checkPromotions(record, DEFAULT_CONFIG)
        expect(promoted).toBe(0)
        expect(mechanic.depthClass).toBe('mechanics')
    })

    it('does not promote spirit attractors (already spirit)', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })

        record.attractors[0]!.mutationCount = 100

        const promoted = checkPromotions(record, DEFAULT_CONFIG)
        expect(promoted).toBe(0)
    })

    it('promotes multiple attractors at once', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })

        mutate(record, {
            source: 'test',
            concepts: [
                { label: 'C1', type: 'action', position: V_CODING },
                { label: 'C2', type: 'action', position: V_DEVOPS },
            ],
            relations: [],
        })

        for (const a of record.attractors.filter(a => a.depthClass === 'mechanics')) {
            a.mutationCount = 55
        }

        const promoted = checkPromotions(record, DEFAULT_CONFIG)
        expect(promoted).toBe(2)
    })

    it('respects custom promotion threshold', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })

        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })

        const mechanic = record.attractors.find(a => a.label === 'Coding')!
        mechanic.mutationCount = 5

        const promoted = checkPromotions(record, { ...DEFAULT_CONFIG, promotionMutationCount: 3 })
        expect(promoted).toBe(1)
    })

    it('promotion is triggered during mutate pipeline', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
        })

        // Add mechanic
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'action', position: V_CODING }],
            relations: [],
        })

        // Set mutation count just below threshold
        const mechanic = record.attractors.find(a => a.label === 'Coding')!
        mechanic.mutationCount = 49

        // Close enough to refine
        const close = [0.05, 0.05, 0.95, 0.05]
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Near Coding', type: 'action', position: close }],
            relations: [],
        })

        // After mutation, count is 50 — exactly at threshold, not above
        expect(mechanic.mutationCount).toBe(50)
        // Not promoted yet (> 50 required)
        expect(mechanic.depthClass).toBe('mechanics')

        // One more refinement → 51 → promoted
        mutate(record, {
            source: 'test',
            concepts: [{ label: 'Near Coding 2', type: 'action', position: close }],
            relations: [],
        })

        expect(mechanic.depthClass).toBe('spirit')
        expect(mechanic.driftProtected).toBe(true)
    })
})
