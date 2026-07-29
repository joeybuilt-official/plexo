// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * 5-point landmark face alignment.
 *
 * ArcFace expects a 112×112 face crop aligned to a canonical 5-landmark
 * template (left eye, right eye, nose, left mouth, right mouth).
 * InsightFace's reference template is the constant `ARC_TEMPLATE` below.
 *
 * Given 5 detected landmarks in source pixels, we fit the similarity
 * transform (rotation + uniform scale + translation) that maps detected
 * → template by closed-form least squares, then resample the source image
 * with that transform into a 112×112 aligned RGB crop.
 *
 * The fit assumes the orientation-preserving family `[[a, -b], [b, a]]`
 * (i.e. rotation + scale, no reflection). This matches scikit-image's
 * `SimilarityTransform.estimate` behaviour, which is what InsightFace's
 * Python reference uses.
 */

export const ARC_TEMPLATE: Array<[number, number]> = [
    [38.2946, 51.6963], // left eye
    [73.5318, 51.5014], // right eye
    [56.0252, 71.7366], // nose
    [41.5493, 92.3655], // left mouth corner
    [70.7299, 92.2041], // right mouth corner
]

export const ARC_INPUT_SIZE = 112

/**
 * Solve `M[a, b, tx, ty]^T = y` in least-squares sense for a similarity
 * transform mapping src → dst. Returns the 2×3 affine matrix
 * `[ax, ay, tx, bx, by, ty]` where:
 *
 *     [x_dst]   [ ax  ay ] [x_src]   [tx]
 *     [y_dst] = [ bx  by ] [y_src] + [ty]
 *
 * For a similarity transform (rotation + scale, no reflection),
 * (ax, ay, bx, by) = (a, -b, b, a). The normal equations are 4×4 and we
 * invert manually.
 */
export function similarityTransform(
    src: Array<[number, number]>,
    dst: Array<[number, number]>,
): [number, number, number, number, number, number] {
    const n = src.length
    if (n !== dst.length || n < 2) {
        throw new Error('similarityTransform: need ≥2 paired points')
    }

    // Each src/dst pair (sx, sy) → (dx, dy) produces two equations:
    //   dx = a*sx - b*sy + tx
    //   dy = b*sx + a*sy + ty
    // Build M (2n × 4) and y (2n × 1), then solve via normal eqns.
    // Accumulate (M^T M) and (M^T y) directly — both are tiny (4×4, 4×1).
    let mtm00 = 0,
        mtm01 = 0,
        mtm02 = 0,
        mtm03 = 0
    let mtm11 = 0,
        mtm12 = 0,
        mtm13 = 0
    let mtm22 = 0,
        mtm23 = 0
    let mtm33 = 0
    let mty0 = 0,
        mty1 = 0,
        mty2 = 0,
        mty3 = 0

    for (let i = 0; i < n; i++) {
        const sx = src[i]![0]
        const sy = src[i]![1]
        const dx = dst[i]![0]
        const dy = dst[i]![1]
        // Row 1 of M: [sx, -sy, 1, 0]  → contributes (sx, -sy, 1, 0)
        // Row 2 of M: [sy,  sx, 0, 1]  → contributes (sy,  sx, 0, 1)
        // M^T M sums outer products row-wise. By symmetry only the upper
        // triangle is updated; lower triangle filled in below.
        // Row 1 outer-product:
        mtm00 += sx * sx
        mtm01 += sx * -sy
        mtm02 += sx * 1
        mtm03 += sx * 0
        mtm11 += -sy * -sy
        mtm12 += -sy * 1
        mtm13 += -sy * 0
        mtm22 += 1 * 1
        mtm23 += 1 * 0
        mtm33 += 0 * 0
        // Row 2 outer-product:
        mtm00 += sy * sy
        mtm01 += sy * sx
        mtm02 += sy * 0
        mtm03 += sy * 1
        mtm11 += sx * sx
        mtm12 += sx * 0
        mtm13 += sx * 1
        mtm22 += 0 * 0
        mtm23 += 0 * 1
        mtm33 += 1 * 1
        // M^T y:
        mty0 += sx * dx + sy * dy
        mty1 += -sy * dx + sx * dy
        mty2 += 1 * dx + 0 * dy
        mty3 += 0 * dx + 1 * dy
    }

    // Solve the 4×4 symmetric system. With M = [[a, -b], [b, a]] the
    // structure is sparse: mtm01 = 0 and mtm cross terms simplify. Easier
    // to just invert directly via Gauss-Jordan. The matrix is symmetric
    // PSD so it's stable for any well-conditioned point set.
    const A = [
        [mtm00, mtm01, mtm02, mtm03],
        [mtm01, mtm11, mtm12, mtm13],
        [mtm02, mtm12, mtm22, mtm23],
        [mtm03, mtm13, mtm23, mtm33],
    ]
    const y = [mty0, mty1, mty2, mty3]
    const sol = solve4x4(A, y)
    const a = sol[0]!
    const bNeg = sol[1]!
    const tx = sol[2]!
    const ty = sol[3]!
    // The 2×3 forward affine:
    //   [ax ay tx]   [ a  -b  tx]
    //   [bx by ty] = [ b   a  ty]
    return [a, -bNeg, tx, bNeg, a, ty]
}

// Gauss-Jordan solver for a 4×4 linear system. Augments A with y as a
// 5th column and reduces to identity. Numerical conditioning is fine for
// the small face-landmark problem.
function solve4x4(A: number[][], y: number[]): number[] {
    const M: number[][] = A.map((row, i) => [...row, y[i]!])
    const n = 4
    for (let i = 0; i < n; i++) {
        // Pivot: pick max |entry| in column i, rows i..n-1
        let pivot = i
        let max = Math.abs(M[i]![i]!)
        for (let r = i + 1; r < n; r++) {
            const v = Math.abs(M[r]![i]!)
            if (v > max) {
                max = v
                pivot = r
            }
        }
        if (max < 1e-12) throw new Error('solve4x4: singular matrix')
        if (pivot !== i) {
            const tmp = M[i]!
            M[i] = M[pivot]!
            M[pivot] = tmp
        }
        const div = M[i]![i]!
        for (let c = i; c <= n; c++) M[i]![c] = M[i]![c]! / div
        for (let r = 0; r < n; r++) {
            if (r === i) continue
            const factor = M[r]![i]!
            for (let c = i; c <= n; c++) M[r]![c] = M[r]![c]! - factor * M[i]![c]!
        }
    }
    return M.map((row) => row[n]!)
}

/**
 * Resample `source` (raw RGB bytes, HWC layout, srcW×srcH) through the
 * affine `[ax,ay,tx,bx,by,ty]` into a 112×112 RGB Buffer (HWC). Inverts
 * the forward affine and bilinearly samples the source on the inverse map.
 */
export function applyAffineRGB(
    source: Buffer,
    srcW: number,
    srcH: number,
    affine: [number, number, number, number, number, number],
): Buffer {
    const [a, b, tx, c, d, ty] = affine
    const det = a * d - b * c
    if (Math.abs(det) < 1e-9) {
        throw new Error('applyAffineRGB: degenerate affine (det ≈ 0)')
    }
    const invA = d / det
    const invB = -b / det
    const invC = -c / det
    const invD = a / det
    const out = Buffer.alloc(ARC_INPUT_SIZE * ARC_INPUT_SIZE * 3)
    for (let dy = 0; dy < ARC_INPUT_SIZE; dy++) {
        for (let dx = 0; dx < ARC_INPUT_SIZE; dx++) {
            const sx = invA * (dx - tx) + invB * (dy - ty)
            const sy = invC * (dx - tx) + invD * (dy - ty)
            const outIdx = (dy * ARC_INPUT_SIZE + dx) * 3
            if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) {
                out[outIdx] = 0
                out[outIdx + 1] = 0
                out[outIdx + 2] = 0
                continue
            }
            const x0 = Math.floor(sx)
            const y0 = Math.floor(sy)
            const x1 = x0 + 1
            const y1 = y0 + 1
            const fx = sx - x0
            const fy = sy - y0
            const idx00 = (y0 * srcW + x0) * 3
            const idx01 = (y0 * srcW + x1) * 3
            const idx10 = (y1 * srcW + x0) * 3
            const idx11 = (y1 * srcW + x1) * 3
            for (let ch = 0; ch < 3; ch++) {
                const v00 = source[idx00 + ch]!
                const v01 = source[idx01 + ch]!
                const v10 = source[idx10 + ch]!
                const v11 = source[idx11 + ch]!
                const v0 = v00 * (1 - fx) + v01 * fx
                const v1 = v10 * (1 - fx) + v11 * fx
                out[outIdx + ch] = Math.round(v0 * (1 - fy) + v1 * fy)
            }
        }
    }
    return out
}
