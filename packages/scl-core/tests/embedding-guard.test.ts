// SPDX-License-Identifier: AGPL-3.0-only
// Embedding consistency guard — verifies mutate() rejects vectors with mismatched
// dimensions, including the embeddingDimensions fallback for empty records.

import { describe, it, expect } from 'vitest'
import { mutate, EmbeddingDimensionMismatchError } from '../src/mutate.js'
import type { GoldenRecord, MutationInput } from '../src/types.js'

function makeRecord(dim: number): GoldenRecord {
    return {
        id: 'test-record',
        version: 'scl/1.0',
        workspaceId: 'test-ws',
        regions: [{
            id: 'r1',
            label: 'test-region',
            centroid: new Array(dim).fill(0.1),
            radius: 1.0,
            density: 0.5,
            children: [],
        }],
        attractors: [{
            id: 'a1',
            position: new Array(dim).fill(0.5),
            regionId: 'r1',
            type: 'entity',
            depthClass: 'mechanics',
            salience: 0.5,
            driftProtected: false,
            label: 'existing-concept',
            mutationCount: 0,
            lastMutatedAt: Date.now(),
        }],
        transformations: [],
        ledgerRefs: [],
        bootedAt: Date.now(),
        lastMutatedAt: Date.now(),
    }
}

function makeInput(dim: number): MutationInput {
    return {
        concepts: [{
            label: 'new-concept',
            position: new Array(dim).fill(0.3),
            type: 'entity',
        }],
        relations: [],
        source: 'test',
    }
}

describe('Embedding Consistency Guard', () => {
    it('accepts mutation when dimensions match', () => {
        const record = makeRecord(384)
        const input = makeInput(384)
        const result = mutate(record, input)
        expect(result.attractorsCreated + result.attractorsRefined).toBeGreaterThan(0)
    })

    it('rejects mutation when dimensions mismatch (384 vs 1536)', () => {
        const record = makeRecord(384)
        const input = makeInput(1536)
        expect(() => mutate(record, input)).toThrow(EmbeddingDimensionMismatchError)
    })

    it('rejects mutation when dimensions mismatch (1536 vs 384)', () => {
        const record = makeRecord(1536)
        const input = makeInput(384)
        expect(() => mutate(record, input)).toThrow(EmbeddingDimensionMismatchError)
    })

    it('error message includes both dimensions', () => {
        const record = makeRecord(384)
        const input = makeInput(1536)
        try {
            mutate(record, input)
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err).toBeInstanceOf(EmbeddingDimensionMismatchError)
            const e = err as EmbeddingDimensionMismatchError
            expect(e.expected).toBe(384)
            expect(e.received).toBe(1536)
            expect(e.message).toContain('384')
            expect(e.message).toContain('1536')
        }
    })

    it('allows mutation when attractors are empty and embeddingDimensions is not set', () => {
        // Original behaviour: no attractors + no lineage → any dimension accepted.
        const record = makeRecord(384)
        record.attractors = []
        const input = makeInput(1536)
        const result = mutate(record, input)
        expect(result.attractorsCreated).toBe(1)
    })

    it('allows mutation with empty input concepts', () => {
        const record = makeRecord(384)
        const input = makeInput(384)
        input.concepts = []
        const result = mutate(record, input)
        expect(result.attractorsCreated).toBe(0)
        expect(result.attractorsRefined).toBe(0)
    })

    it('rejects mutation when attractors are empty but embeddingDimensions signals a mismatch', () => {
        // Gap closed by the embeddingDimensions fallback:
        // A workspace booted with 1536-dim OpenAI then had all mechanics pruned.
        // Without the fallback, a 384-dim mutation would silently corrupt the record.
        const record = makeRecord(1536)
        record.attractors = []
        record.embeddingDimensions = 1536
        const input = makeInput(384)
        expect(() => mutate(record, input)).toThrow(EmbeddingDimensionMismatchError)
    })

    it('embeddingDimensions fallback error reports correct dimensions', () => {
        const record = makeRecord(1536)
        record.attractors = []
        record.embeddingDimensions = 1536
        const input = makeInput(384)
        try {
            mutate(record, input)
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err).toBeInstanceOf(EmbeddingDimensionMismatchError)
            const e = err as EmbeddingDimensionMismatchError
            expect(e.expected).toBe(1536)
            expect(e.received).toBe(384)
        }
    })
})
