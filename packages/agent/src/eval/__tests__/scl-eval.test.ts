// SPDX-License-Identifier: MIT
// Tests for SCL evaluation metrics — deterministic, no LLM calls.

import { describe, it, expect } from 'vitest'
import {
    recallAtK, precisionAtK, ndcgAtK, mrr,
    promotionCorrectness, summarize,
} from '../scl-eval.js'

describe('recallAtK', () => {
    it('returns 1.0 when all expected items are in top-k', () => {
        expect(recallAtK(['a', 'b', 'c', 'd', 'e'], ['a', 'c'], 5)).toBe(1.0)
    })

    it('returns 0.5 when half of expected items are in top-k', () => {
        expect(recallAtK(['a', 'b', 'c', 'd', 'e'], ['a', 'z'], 5)).toBe(0.5)
    })

    it('returns 0.0 when no expected items are in top-k', () => {
        expect(recallAtK(['a', 'b', 'c'], ['x', 'y'], 3)).toBe(0.0)
    })

    it('returns 1.0 for empty expected set (vacuously true)', () => {
        expect(recallAtK(['a', 'b'], [], 5)).toBe(1.0)
    })

    it('respects k limit', () => {
        expect(recallAtK(['a', 'b', 'c', 'd', 'e'], ['e'], 3)).toBe(0.0)
        expect(recallAtK(['a', 'b', 'c', 'd', 'e'], ['e'], 5)).toBe(1.0)
    })
})

describe('precisionAtK', () => {
    it('returns 1.0 when all top-k items are expected', () => {
        expect(precisionAtK(['a', 'b'], ['a', 'b', 'c'], 2)).toBe(1.0)
    })

    it('returns 0.5 when half of top-k are expected', () => {
        expect(precisionAtK(['a', 'x', 'b', 'y'], ['a', 'b'], 4)).toBe(0.5)
    })

    it('returns 0.0 when no top-k items are expected', () => {
        expect(precisionAtK(['x', 'y', 'z'], ['a', 'b'], 3)).toBe(0.0)
    })
})

describe('ndcgAtK', () => {
    it('returns 1.0 for perfect ranking', () => {
        expect(ndcgAtK(['a', 'b', 'c'], ['a', 'b', 'c'], 3)).toBe(1.0)
    })

    it('returns less than 1.0 for imperfect ranking', () => {
        const score = ndcgAtK(['x', 'a', 'b', 'c'], ['a', 'b', 'c'], 4)
        expect(score).toBeGreaterThan(0)
        expect(score).toBeLessThan(1)
    })

    it('returns 0.0 when no expected items in top-k', () => {
        expect(ndcgAtK(['x', 'y', 'z'], ['a', 'b'], 3)).toBe(0.0)
    })
})

describe('mrr', () => {
    it('returns 1.0 when first item is relevant', () => {
        expect(mrr(['a', 'b', 'c'], ['a'])).toBe(1.0)
    })

    it('returns 0.5 when second item is first relevant', () => {
        expect(mrr(['x', 'a', 'c'], ['a'])).toBe(0.5)
    })

    it('returns 0.0 when no relevant items found', () => {
        expect(mrr(['x', 'y', 'z'], ['a'])).toBe(0.0)
    })
})

describe('promotionCorrectness', () => {
    it('returns 1.0 for true positive', () => {
        expect(promotionCorrectness(true, true)).toBe(1.0)
    })

    it('returns 1.0 for true negative', () => {
        expect(promotionCorrectness(false, false)).toBe(1.0)
    })

    it('returns 0.0 for false positive', () => {
        expect(promotionCorrectness(true, false)).toBe(0.0)
    })

    it('returns 0.0 for false negative', () => {
        expect(promotionCorrectness(false, true)).toBe(0.0)
    })
})

describe('summarize', () => {
    it('computes aggregate metrics across samples', () => {
        const results = [
            { retrieved: ['a', 'b', 'c', 'd', 'e'], expected: ['a', 'c'] },
            { retrieved: ['x', 'y', 'z', 'w', 'v'], expected: ['a', 'b'] },
        ]
        const summary = summarize(results)
        expect(summary.sampleCount).toBe(2)
        expect(summary.recallAt5).toBe(0.5) // (1.0 + 0.0) / 2
        expect(summary.precisionAt5).toBeGreaterThanOrEqual(0)
        expect(summary.ndcgAt5).toBeGreaterThanOrEqual(0)
    })

    it('returns zeros for empty results', () => {
        const summary = summarize([])
        expect(summary.sampleCount).toBe(0)
        expect(summary.recallAt5).toBe(0)
    })

    it('computes promotion F1', () => {
        const results = [
            { retrieved: [], expected: [], wasPromoted: true, shouldBePromoted: true },   // TP
            { retrieved: [], expected: [], wasPromoted: true, shouldBePromoted: false },  // FP
            { retrieved: [], expected: [], wasPromoted: false, shouldBePromoted: true },  // FN
            { retrieved: [], expected: [], wasPromoted: false, shouldBePromoted: false }, // TN
        ]
        const summary = summarize(results)
        // precision = 1/(1+1) = 0.5, recall = 1/(1+1) = 0.5, F1 = 0.5
        expect(summary.promotionF1).toBeCloseTo(0.5)
    })
})
