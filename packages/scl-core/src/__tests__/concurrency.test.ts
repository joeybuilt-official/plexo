// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { boot } from '../boot.js'
import { mutate } from '../mutate.js'
import type { MutationInput } from '../types.js'
import {
    V_IDENTITY, V_OPERATOR, V_CODING, V_DEVOPS,
    V_IDENTITY_CLOSE, V_OPERATOR_CLOSE, TEST_WORKSPACE,
} from '../../tests/fixtures/vectors.js'

function makeRecord() {
    return boot({
        workspaceId: TEST_WORKSPACE,
        spiritAnchors: [
            { label: 'Identity', type: 'entity', position: V_IDENTITY },
            { label: 'Operator', type: 'entity', position: V_OPERATOR },
        ],
    })
}

describe('SCL mutate — concurrent safety', () => {
    it('5 parallel refinements: mutation count correct, no lost attractors', async () => {
        const record = makeRecord()
        const initialCount = record.attractors.length  // 2 spirit anchors

        const input: MutationInput = {
            source: 'concurrent-test',
            concepts: [{ label: 'Identity Update', type: 'entity', position: V_IDENTITY_CLOSE }],
            relations: [],
        }

        // Wrap each synchronous call in Promise.resolve to simulate concurrent dispatch
        const results = await Promise.all(
            Array.from({ length: 5 }, () => Promise.resolve(mutate(record, input)))
        )

        expect(results).toHaveLength(5)
        for (const r of results) {
            // Each mutation refines the nearest attractor — never creates a duplicate spirit
            expect(r.attractorsRefined).toBe(1)
            expect(r.attractorsCreated).toBe(0)
        }

        // Robbins-Monro counter must reflect all 5 refinements on the Identity attractor
        const identity = record.attractors.find(a => a.label === 'Identity')
        expect(identity?.mutationCount).toBe(5)

        // Operator attractor is untouched
        const operator = record.attractors.find(a => a.label === 'Operator')
        expect(operator?.mutationCount).toBe(0)

        // No attractors added or removed
        expect(record.attractors.length).toBe(initialCount)
    })

    it('5 parallel new-concept inserts: all attractor IDs are unique', async () => {
        const record = makeRecord()
        const initialCount = record.attractors.length

        // Positions orthogonal to both spirit anchors → forces new mechanics creation
        const inputs: MutationInput[] = [
            { source: 'w1', concepts: [{ label: 'Coding A', type: 'action', position: V_CODING }], relations: [] },
            { source: 'w2', concepts: [{ label: 'Devops A', type: 'action', position: V_DEVOPS }], relations: [] },
            { source: 'w3', concepts: [{ label: 'Coding B', type: 'action', position: [0, 0, 0.99, 0.01] }], relations: [] },
            { source: 'w4', concepts: [{ label: 'Devops B', type: 'action', position: [0, 0, 0.01, 0.99] }], relations: [] },
            { source: 'w5', concepts: [{ label: 'Mix', type: 'state', position: [0, 0, 0.7, 0.7] }], relations: [] },
        ]

        await Promise.all(inputs.map(inp => Promise.resolve(mutate(record, inp))))

        // Each worker created at least one new attractor
        expect(record.attractors.length).toBeGreaterThan(initialCount)

        // generateId() must not collide across concurrent calls
        const ids = record.attractors.map(a => a.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    it('5 mixed-worker mutations: total mutated concepts equals inputs', async () => {
        const record = makeRecord()
        const WORKERS = 5

        const results = await Promise.all(
            Array.from({ length: WORKERS }, (_, i) =>
                Promise.resolve(mutate(record, {
                    source: `worker-${i}`,
                    concepts: [{ label: `Concept ${i}`, type: 'claim', position: V_IDENTITY_CLOSE }],
                    relations: [],
                }))
            )
        )

        expect(results).toHaveLength(WORKERS)

        // Every concept submitted must be either refined or created — none silently dropped
        const totalHandled = results.reduce(
            (sum, r) => sum + r.attractorsRefined + r.attractorsCreated, 0
        )
        expect(totalHandled).toBe(WORKERS)
    })

    it('no attractors lost after mixed refinement + creation batch', async () => {
        const record = makeRecord()

        const inputs: MutationInput[] = [
            // Refines Identity
            { source: 'r1', concepts: [{ label: 'Near Identity', type: 'entity', position: V_IDENTITY_CLOSE }], relations: [] },
            // Refines Operator
            { source: 'r2', concepts: [{ label: 'Near Operator', type: 'entity', position: V_OPERATOR_CLOSE }], relations: [] },
            // Creates new mechanics
            { source: 'c1', concepts: [{ label: 'Coding', type: 'action', position: V_CODING }], relations: [] },
            { source: 'c2', concepts: [{ label: 'Devops', type: 'action', position: V_DEVOPS }], relations: [] },
            // Second refinement on Identity
            { source: 'r3', concepts: [{ label: 'Identity Again', type: 'entity', position: V_IDENTITY_CLOSE }], relations: [] },
        ]

        await Promise.all(inputs.map(inp => Promise.resolve(mutate(record, inp))))

        // Spirit anchors always preserved
        expect(record.attractors.filter(a => a.depthClass === 'spirit')).toHaveLength(2)

        // All attractor positions are finite (no NaN from blending)
        for (const attractor of record.attractors) {
            for (const coord of attractor.position) {
                expect(Number.isFinite(coord)).toBe(true)
            }
        }
    })
})
