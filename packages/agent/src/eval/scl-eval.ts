// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL Evaluation Harness — measures retrieval quality against ground truth.
 *
 * Computes classical IR metrics (recall@k, precision@k, NDCG@k) for SCL
 * expansion. No LLM judge needed — all metrics are deterministic computations
 * from pgvector similarity rankings vs labeled ground truth.
 *
 * Ground truth stored in `scl_eval_ground_truth` table.
 * Results written to `eval_results` table in plexo_ops.
 *
 * Patterns borrowed from:
 * - TruLens: SQL-backed ground truth persistence
 * - DeepEval: pluggable metric interface
 * - Ragas: precision@k algorithm
 */

export interface EvalMetric {
    name: string
    compute(retrieved: string[], expected: string[]): number
}

/**
 * Recall@k: fraction of expected items that appear in the top-k retrieved items.
 * recall@k = |retrieved_k ∩ expected| / |expected|
 */
export function recallAtK(retrieved: string[], expected: string[], k: number): number {
    if (expected.length === 0) return 1.0 // vacuously true
    const topK = retrieved.slice(0, k)
    const hits = expected.filter(id => topK.includes(id))
    return hits.length / expected.length
}

/**
 * Precision@k: fraction of top-k retrieved items that are in the expected set.
 * precision@k = |retrieved_k ∩ expected| / k
 */
export function precisionAtK(retrieved: string[], expected: string[], k: number): number {
    if (k === 0) return 0
    const topK = retrieved.slice(0, k)
    const hits = topK.filter(id => expected.includes(id))
    return hits.length / Math.min(k, topK.length)
}

/**
 * NDCG@k: Normalized Discounted Cumulative Gain.
 * Measures ranking quality — relevant items ranked higher score better.
 */
export function ndcgAtK(retrieved: string[], expected: string[], k: number): number {
    const topK = retrieved.slice(0, k)
    const expectedSet = new Set(expected)

    // DCG: sum of 1/log2(rank+1) for each relevant item in top-k
    let dcg = 0
    for (let i = 0; i < topK.length; i++) {
        if (expectedSet.has(topK[i]!)) {
            dcg += 1 / Math.log2(i + 2) // rank is 1-indexed, log2(1+1)=1
        }
    }

    // Ideal DCG: all expected items ranked first
    const idealK = Math.min(expected.length, k)
    let idcg = 0
    for (let i = 0; i < idealK; i++) {
        idcg += 1 / Math.log2(i + 2)
    }

    return idcg === 0 ? 0 : dcg / idcg
}

/**
 * Mean Reciprocal Rank: 1/rank of the first relevant item.
 */
export function mrr(retrieved: string[], expected: string[]): number {
    const expectedSet = new Set(expected)
    for (let i = 0; i < retrieved.length; i++) {
        if (expectedSet.has(retrieved[i]!)) {
            return 1 / (i + 1)
        }
    }
    return 0
}

/**
 * Promotion correctness: binary — did this attractor correctly get promoted?
 * Returns 1.0 if the prediction matches ground truth, 0.0 otherwise.
 */
export function promotionCorrectness(wasPromoted: boolean, shouldBePromoted: boolean): number {
    return wasPromoted === shouldBePromoted ? 1.0 : 0.0
}

/**
 * Aggregate eval results across multiple test cases.
 */
export interface EvalSummary {
    recallAt5: number
    precisionAt5: number
    ndcgAt5: number
    avgMrr: number
    promotionF1: number
    sampleCount: number
}

export function summarize(results: Array<{
    retrieved: string[]
    expected: string[]
    wasPromoted?: boolean
    shouldBePromoted?: boolean
}>): EvalSummary {
    if (results.length === 0) {
        return { recallAt5: 0, precisionAt5: 0, ndcgAt5: 0, avgMrr: 0, promotionF1: 0, sampleCount: 0 }
    }

    let totalRecall = 0
    let totalPrecision = 0
    let totalNdcg = 0
    let totalMrr = 0
    let tp = 0, fp = 0, fn = 0

    for (const r of results) {
        totalRecall += recallAtK(r.retrieved, r.expected, 5)
        totalPrecision += precisionAtK(r.retrieved, r.expected, 5)
        totalNdcg += ndcgAtK(r.retrieved, r.expected, 5)
        totalMrr += mrr(r.retrieved, r.expected)

        if (r.wasPromoted !== undefined && r.shouldBePromoted !== undefined) {
            if (r.wasPromoted && r.shouldBePromoted) tp++
            else if (r.wasPromoted && !r.shouldBePromoted) fp++
            else if (!r.wasPromoted && r.shouldBePromoted) fn++
        }
    }

    const n = results.length
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0
    const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0

    return {
        recallAt5: totalRecall / n,
        precisionAt5: totalPrecision / n,
        ndcgAt5: totalNdcg / n,
        avgMrr: totalMrr / n,
        promotionF1: f1,
        sampleCount: n,
    }
}
