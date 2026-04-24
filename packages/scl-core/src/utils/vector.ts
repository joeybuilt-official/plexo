// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0

    let dot = 0
    let magA = 0
    let magB = 0

    for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!
        magA += a[i]! * a[i]!
        magB += b[i]! * b[i]!
    }

    // √a·√b = √(a·b) — one sqrt call instead of two; mathematically identical for a,b ≥ 0.
    const denom = Math.sqrt(magA * magB)
    if (denom === 0) return 0

    return dot / denom
}

export function weightedAverage(
    a: number[],
    b: number[],
    weightA: number,
    weightB: number,
): number[] {
    if (a.length !== b.length) throw new Error('Vector dimension mismatch')
    return a.map((v, i) => v * weightA + b[i]! * weightB)
}

export function centroid(vectors: number[][]): number[] {
    if (vectors.length === 0) return []
    const dims = vectors[0]!.length
    const sum = new Array<number>(dims).fill(0)
    for (const v of vectors) {
        for (let i = 0; i < dims; i++) {
            sum[i]! += v[i]!
        }
    }
    return sum.map(s => s / vectors.length)
}

export function euclideanDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) return Infinity
    let sum = 0
    for (let i = 0; i < a.length; i++) {
        const d = a[i]! - b[i]!
        sum += d * d
    }
    return Math.sqrt(sum)
}

export function magnitude(v: number[]): number {
    let sum = 0
    for (const x of v) sum += x * x
    return Math.sqrt(sum)
}
