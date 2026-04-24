// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL core boot() and mutate() unit tests.
 *
 * Pins:
 *   1. boot() — correct GoldenRecord structure (id, version, workspaceId, regions, attractors)
 *   2. boot() — centroid computed from spirit anchors; empty anchors → empty centroid
 *   3. mutate() — EmbeddingDimensionMismatchError thrown on dimension conflict
 *   4. mutate() — no dimension guard when record has no attractors and no embeddingDimensions
 *   5. mutate() — new attractor created when concept is far from all existing attractors
 *   6. mutate() — drift warning emitted (mutation blocked) for spirit anchor past spiritDriftThreshold
 */

import { describe, it, expect } from 'vitest'
import { boot } from '../boot.js'
import { mutate, EmbeddingDimensionMismatchError } from '../mutate.js'
import type { MutationInput } from '../types.js'
import {
    V_IDENTITY, V_OPERATOR, V_CODING,
    V_IDENTITY_CLOSE, V_IDENTITY_DRIFT,
    TEST_WORKSPACE,
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

// ── boot() ─────────────────────────────────────────────────────────────────

describe('boot()', () => {
    it('produces a GoldenRecord with correct metadata', () => {
        const record = makeRecord()
        expect(record.version).toBe('scl/1.0')
        expect(record.workspaceId).toBe(TEST_WORKSPACE)
        expect(typeof record.id).toBe('string')
        expect(record.id.length).toBeGreaterThan(0)
        expect(record.attractors).toHaveLength(2)
        expect(record.regions).toHaveLength(1)
        expect(record.transformations).toHaveLength(0)
    })

    it('creates spirit attractors with driftProtected=true and depthClass=spirit', () => {
        const record = makeRecord()
        for (const attractor of record.attractors) {
            expect(attractor.driftProtected).toBe(true)
            expect(attractor.depthClass).toBe('spirit')
            expect(attractor.salience).toBe(1.0)
            expect(attractor.mutationCount).toBe(0)
        }
        const labels = record.attractors.map(a => a.label)
        expect(labels).toContain('Identity')
        expect(labels).toContain('Operator')
    })

    it('computes the root region centroid from spirit anchor positions', () => {
        const record = makeRecord()
        const rootRegion = record.regions[0]!
        // centroid([1,0,0,0], [0,1,0,0]) = [0.5, 0.5, 0, 0]
        expect(rootRegion.centroid).toEqual([0.5, 0.5, 0, 0])
        expect(rootRegion.label).toBe('root')
        expect(rootRegion.density).toBe(2)
    })

    it('produces an empty centroid and no attractors when spiritAnchors is empty', () => {
        const record = boot({ workspaceId: TEST_WORKSPACE, spiritAnchors: [] })
        expect(record.attractors).toHaveLength(0)
        expect(record.regions[0]!.centroid).toEqual([])
        expect(record.regions[0]!.density).toBe(0)
    })
})

// ── mutate() — EmbeddingDimensionMismatchError ─────────────────────────────

describe('mutate() — EmbeddingDimensionMismatchError', () => {
    it('throws when incoming concept has different dimensions than existing attractors', () => {
        const record = makeRecord()  // 4-dim attractors
        const input: MutationInput = {
            source: 'test',
            concepts: [{ label: 'WrongDim', type: 'entity', position: [1, 0, 0] }],  // 3-dim
            relations: [],
        }
        expect(() => mutate(record, input)).toThrow(EmbeddingDimensionMismatchError)
    })

    it('EmbeddingDimensionMismatchError carries expected and received dimensions', () => {
        const record = makeRecord()  // 4-dim attractors
        const input: MutationInput = {
            source: 'test',
            concepts: [{ label: 'WrongDim', type: 'entity', position: [1, 0, 0] }],  // 3-dim
            relations: [],
        }
        let caught: EmbeddingDimensionMismatchError | null = null
        try {
            mutate(record, input)
        } catch (err) {
            caught = err as EmbeddingDimensionMismatchError
        }
        expect(caught).toBeInstanceOf(EmbeddingDimensionMismatchError)
        expect(caught!.expected).toBe(4)
        expect(caught!.received).toBe(3)
    })

    it('does NOT throw when record has no attractors and no embeddingDimensions set', () => {
        const emptyRecord = boot({ workspaceId: TEST_WORKSPACE, spiritAnchors: [] })
        const input: MutationInput = {
            source: 'test',
            concepts: [{ label: 'AnyDim', type: 'entity', position: [1, 2, 3] }],
            relations: [],
        }
        // No reference dimension — guard does not run
        expect(() => mutate(emptyRecord, input)).not.toThrow()
    })
})

// ── mutate() — new attractor creation ─────────────────────────────────────

describe('mutate() — new attractor creation', () => {
    it('creates a new mechanics attractor when concept is far from all existing ones', () => {
        const record = makeRecord()
        const before = record.attractors.length

        const input: MutationInput = {
            source: 'test',
            concepts: [{ label: 'Coding', type: 'entity', position: V_CODING }],
            relations: [],
        }
        const result = mutate(record, input)

        expect(result.attractorsCreated).toBe(1)
        expect(result.attractorsRefined).toBe(0)
        expect(record.attractors.length).toBe(before + 1)

        const newOne = record.attractors.find(a => a.label === 'Coding')
        expect(newOne).toBeDefined()
        expect(newOne!.depthClass).toBe('mechanics')
        expect(newOne!.driftProtected).toBe(false)
    })

    it('refines an existing attractor when concept is close (not drift-protected)', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [],
        })
        // Seed a mechanics attractor manually by mutating once
        mutate(record, {
            source: 'seed',
            concepts: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
            relations: [],
        })
        const before = record.attractors.length

        // Second mutation with a close vector should refine, not create
        const result = mutate(record, {
            source: 'test',
            concepts: [{ label: 'Identity Refinement', type: 'entity', position: V_IDENTITY_CLOSE }],
            relations: [],
        })

        expect(result.attractorsRefined).toBe(1)
        expect(result.attractorsCreated).toBe(0)
        expect(record.attractors.length).toBe(before)
    })
})

// ── mutate() — drift warning ───────────────────────────────────────────────

describe('mutate() — drift warning', () => {
    it('emits a drift warning and blocks mutation when spirit anchor is nudged past spiritDriftThreshold', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'Identity', type: 'entity', position: V_IDENTITY },
            ],
        })

        const input: MutationInput = {
            source: 'test',
            // V_IDENTITY_DRIFT: distance ~0.16, within refinementThreshold (0.3) but beyond spiritDriftThreshold (0.15)
            concepts: [{ label: 'Identity Drift', type: 'entity', position: V_IDENTITY_DRIFT }],
            relations: [],
        }

        const result = mutate(record, input)

        expect(result.driftWarnings).toHaveLength(1)
        expect(result.driftWarnings[0]!.attractorLabel).toBe('Identity')
        expect(result.driftWarnings[0]!.status).toBe('pending')
        expect(result.attractorsRefined).toBe(0)  // mutation was blocked

        // Spirit anchor position must be unchanged
        const identity = record.attractors.find(a => a.label === 'Identity')
        expect(identity!.position).toEqual(V_IDENTITY)
        expect(identity!.mutationCount).toBe(0)
    })
})
