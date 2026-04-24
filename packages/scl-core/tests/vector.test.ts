// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import {
    cosineSimilarity,
    weightedAverage,
    centroid,
    euclideanDistance,
    magnitude,
} from '../src/utils/vector.js'

// ── cosineSimilarity ──────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
    it('identical vectors → 1.0', () => {
        expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0)
    })

    it('opposite vectors → -1.0', () => {
        expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0)
    })

    it('orthogonal vectors → 0.0', () => {
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0)
    })

    it('zero vector → 0.0 (no division-by-zero crash)', () => {
        expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0)
    })

    it('both zero vectors → 0.0', () => {
        expect(cosineSimilarity([0, 0], [0, 0])).toBe(0)
    })

    it('mismatched lengths → 0.0', () => {
        expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0)
    })

    it('empty vectors → 0.0', () => {
        expect(cosineSimilarity([], [])).toBe(0)
    })

    it('diagonal unit vector similarity is symmetric', () => {
        const a = [1, 1, 0]
        const b = [0, 1, 1]
        expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a))
    })

    it('returns value in [-1, 1]', () => {
        const a = [3, -1, 2]
        const b = [-2, 4, -1]
        const sim = cosineSimilarity(a, b)
        expect(sim).toBeGreaterThanOrEqual(-1)
        expect(sim).toBeLessThanOrEqual(1)
    })

    it('handles negative values correctly', () => {
        // [-1,0] vs [1,0] should be -1.0
        expect(cosineSimilarity([-1, 0], [1, 0])).toBeCloseTo(-1.0)
    })
})

// ── weightedAverage ───────────────────────────────────────────────────────────

describe('weightedAverage', () => {
    it('50/50 blend of [0,0] and [2,2] → [1,1]', () => {
        const result = weightedAverage([0, 0], [2, 2], 0.5, 0.5)
        expect(result).toEqual([1, 1])
    })

    it('100% a, 0% b → returns a unchanged', () => {
        const a = [3, 7]
        const result = weightedAverage(a, [10, 10], 1.0, 0.0)
        expect(result[0]).toBeCloseTo(3)
        expect(result[1]).toBeCloseTo(7)
    })

    it('0% a, 100% b → returns b unchanged', () => {
        const b = [5, 9]
        const result = weightedAverage([0, 0], b, 0.0, 1.0)
        expect(result[0]).toBeCloseTo(5)
        expect(result[1]).toBeCloseTo(9)
    })

    it('standard refinement blend 0.7/0.3', () => {
        const result = weightedAverage([1, 0, 0, 0], [0.5, 0.5, 0.5, 0.5], 0.7, 0.3)
        expect(result[0]).toBeCloseTo(0.85)
        expect(result[1]).toBeCloseTo(0.15)
        expect(result[2]).toBeCloseTo(0.15)
        expect(result[3]).toBeCloseTo(0.15)
    })

    it('throws on dimension mismatch', () => {
        expect(() => weightedAverage([1, 2], [1, 2, 3], 0.5, 0.5)).toThrow('Vector dimension mismatch')
    })

    it('returns a new array (does not mutate inputs)', () => {
        const a = [1, 2]
        const b = [3, 4]
        const result = weightedAverage(a, b, 0.5, 0.5)
        expect(a).toEqual([1, 2])
        expect(b).toEqual([3, 4])
        expect(result).not.toBe(a)
    })
})

// ── centroid ──────────────────────────────────────────────────────────────────

describe('centroid', () => {
    it('empty array → empty array', () => {
        expect(centroid([])).toEqual([])
    })

    it('single vector → same vector', () => {
        expect(centroid([[1, 2, 3]])).toEqual([1, 2, 3])
    })

    it('two identical vectors → same vector', () => {
        expect(centroid([[1, 0], [1, 0]])).toEqual([1, 0])
    })

    it('two opposite unit vectors → zero centroid', () => {
        const result = centroid([[1, 0], [-1, 0]])
        expect(result[0]).toBeCloseTo(0)
        expect(result[1]).toBeCloseTo(0)
    })

    it('four corners of a square → center', () => {
        const result = centroid([[1, 1], [1, -1], [-1, 1], [-1, -1]])
        expect(result[0]).toBeCloseTo(0)
        expect(result[1]).toBeCloseTo(0)
    })

    it('three vectors average correctly', () => {
        const result = centroid([[0, 0], [3, 0], [0, 3]])
        expect(result[0]).toBeCloseTo(1)
        expect(result[1]).toBeCloseTo(1)
    })
})

// ── euclideanDistance ─────────────────────────────────────────────────────────

describe('euclideanDistance', () => {
    it('same vector → 0', () => {
        expect(euclideanDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0)
    })

    it('unit step in one dimension → 1', () => {
        expect(euclideanDistance([0, 0], [1, 0])).toBeCloseTo(1)
    })

    it('Pythagorean 3-4-5 triangle', () => {
        expect(euclideanDistance([0, 0], [3, 4])).toBeCloseTo(5)
    })

    it('mismatched lengths → Infinity', () => {
        expect(euclideanDistance([1, 2], [1, 2, 3])).toBe(Infinity)
    })

    it('symmetric: d(a,b) === d(b,a)', () => {
        const a = [1, 2, 3]
        const b = [4, 5, 6]
        expect(euclideanDistance(a, b)).toBeCloseTo(euclideanDistance(b, a))
    })

    it('handles negative coordinates', () => {
        expect(euclideanDistance([-1, 0], [1, 0])).toBeCloseTo(2)
    })
})

// ── magnitude ─────────────────────────────────────────────────────────────────

describe('magnitude', () => {
    it('zero vector → 0', () => {
        expect(magnitude([0, 0, 0])).toBeCloseTo(0)
    })

    it('unit vector → 1', () => {
        expect(magnitude([1, 0, 0])).toBeCloseTo(1)
    })

    it('unit vector along another axis → 1', () => {
        expect(magnitude([0, 1])).toBeCloseTo(1)
    })

    it('Pythagorean 3-4-5', () => {
        expect(magnitude([3, 4])).toBeCloseTo(5)
    })

    it('handles negative components (magnitude is always non-negative)', () => {
        expect(magnitude([-3, 4])).toBeCloseTo(5)
    })

    it('scalar multiple scales magnitude', () => {
        const m = magnitude([1, 1])
        const m2 = magnitude([2, 2])
        expect(m2).toBeCloseTo(m * 2)
    })
})
