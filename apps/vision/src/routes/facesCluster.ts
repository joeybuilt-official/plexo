// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * GPU-accelerated face-cluster edge builder.
 *
 *   POST /v1/faces/cluster
 *   {
 *     "faces":  [{ "id": string, "vec": float32[512] /* L2-norm *​/ }, ...],
 *     "eps":    0.32,          // optional; cosine-distance threshold
 *     "minPts": 5,             // optional; DBSCAN minPts hint (Node side runs the actual clustering)
 *     "return": "edges"        // currently only "edges" supported
 *   }
 *   →
 *   {
 *     "n":       19873,
 *     "edges":   [[i,j], ...],         // i<j; indices into request.faces
 *     "deg":     [int, ...],           // neighbour count per face
 *     "tookMs":  { matmul, threshold, total },
 *     "ep":      "cuda" | "cpu",
 *     "chunks":  4
 *   }
 *
 * The service intentionally does NOT run DBSCAN itself — clustering
 * topology is cheap on Node and Fonto's clusterer already owns the
 * union-find logic. What's slow in Node is the O(N²) cosine matmul; that
 * lives here on the GPU. We return enough structure (edges + per-face
 * degree) that the caller can run DBSCAN in a single pass with no
 * additional similarity work.
 *
 * Cosine: vectors are required to be L2-normalised already (we don't
 * normalise — that's how Fonto's face-embed step ships them today), so
 * cosine(x,y) = x · y. We compute the upper triangle of X · Xᵀ by tiling
 * rows: for each row-chunk i ∈ [a:a+chunk] we matmul against all columns
 * j ∈ [a:N], then walk the result and emit (i,j) pairs where the score
 * ≥ 1−eps. Result floats are clamped to [-1,1] before threshold to defuse
 * fp drift on cuBLAS.
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import * as ort from 'onnxruntime-node'
import { childLogger } from '../lib/logger.js'
import { measure } from '../lib/telemetry.js'
import { getMatmulSession, withMatmulLock } from '../lib/matmulSession.js'

const logger = childLogger('routes/v1-faces-cluster')
export const facesClusterRouter: ExpressRouter = Router()

const VEC_DIM = 512

const DEFAULT_EPS = 0.32
const DEFAULT_MIN_PTS = 5
const DEFAULT_RETURN = 'edges' as const

const DEFAULT_MAX_N = 50_000
const DEFAULT_CHUNK = 4096

function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const v = parseInt(raw, 10)
    return Number.isFinite(v) && v > 0 ? v : fallback
}

interface ClusterReqFace {
    id?: string
    vec?: number[] | Float32Array
}

interface ClusterRequest {
    faces?: ClusterReqFace[]
    eps?: number
    minPts?: number
    return?: 'edges'
}

interface ClusterResponse {
    n: number
    edges: Array<[number, number]>
    deg: number[]
    tookMs: { matmul: number; threshold: number; total: number }
    ep: 'cuda' | 'cpu'
    chunks: number
}

facesClusterRouter.post('/cluster', async (req: Request, res: Response) => {
    const tStart = performance.now()
    const body = req.body as ClusterRequest

    // ── Validate shape ────────────────────────────────────────────────
    if (!body || !Array.isArray(body.faces)) {
        res.status(400).json({
            error: { message: 'Missing "faces" array', type: 'invalid_request_error' },
        })
        return
    }
    const N = body.faces.length
    const maxN = envInt('VISION_CLUSTER_MAX_N', DEFAULT_MAX_N)
    if (N > maxN) {
        res.status(413).json({
            error: {
                message: `Too many faces (${N} > VISION_CLUSTER_MAX_N=${maxN})`,
                type: 'payload_too_large',
            },
        })
        return
    }
    // Allow eps/minPts to be 0 — but typical defaults if unset.
    const eps = typeof body.eps === 'number' && body.eps >= 0 ? body.eps : DEFAULT_EPS
    const minPts =
        typeof body.minPts === 'number' && body.minPts > 0
            ? Math.floor(body.minPts)
            : DEFAULT_MIN_PTS
    const ret = body.return ?? DEFAULT_RETURN
    if (ret !== 'edges') {
        res.status(400).json({
            error: {
                message: `Unsupported "return" value (only "edges" supported)`,
                type: 'invalid_request_error',
            },
        })
        return
    }

    // Pack vectors row-major into a single Float32Array X[N, 512]. Reject
    // any row that isn't 512 wide.
    const X = new Float32Array(N * VEC_DIM)
    for (let i = 0; i < N; i++) {
        const f = body.faces[i]
        const v = f?.vec
        if (!v || (v as { length?: number }).length !== VEC_DIM) {
            res.status(400).json({
                error: {
                    message: `faces[${i}].vec must be a length-${VEC_DIM} array of floats`,
                    type: 'invalid_request_error',
                },
            })
            return
        }
        const base = i * VEC_DIM
        if (v instanceof Float32Array) {
            X.set(v, base)
        } else {
            for (let k = 0; k < VEC_DIM; k++) X[base + k] = (v as number[])[k] as number
        }
    }

    const chunkSize = envInt('VISION_CLUSTER_CHUNK', DEFAULT_CHUNK)
    const threshold = 1 - eps // cosine ≥ threshold ⇔ distance ≤ eps

    try {
        const result = await measure('faces-cluster', 'matmul_t', async () => {
            return runCluster({ X, N, chunkSize, threshold })
        })
        const tookMsTotal = Math.round(performance.now() - tStart)
        const resp: ClusterResponse = {
            n: N,
            edges: result.edges,
            deg: result.deg,
            tookMs: {
                matmul: Math.round(result.matmulMs),
                threshold: Math.round(result.thresholdMs),
                total: tookMsTotal,
            },
            ep: result.ep,
            chunks: result.chunks,
        }
        logger.info(
            {
                n: N,
                edges: resp.edges.length,
                chunks: resp.chunks,
                ep: resp.ep,
                eps,
                minPts,
                tookMs: resp.tookMs,
            },
            'cluster done',
        )
        res.json(resp)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err, n: N }, '/v1/faces/cluster failed')
        if (/out of memory|cudaMalloc|OOM|CUDA_ERROR_OUT_OF_MEMORY/i.test(msg)) {
            res.status(503).json({
                error: { message: 'GPU out of memory', type: 'gpu_oom' },
            })
            return
        }
        res.status(500).json({
            error: { message: msg, type: 'server_error' },
        })
    }
})

interface RunResult {
    edges: Array<[number, number]>
    deg: number[]
    matmulMs: number
    thresholdMs: number
    chunks: number
    ep: 'cuda' | 'cpu'
}

async function runCluster(args: {
    X: Float32Array
    N: number
    chunkSize: number
    threshold: number
}): Promise<RunResult> {
    const { X, N, chunkSize, threshold } = args
    const ms = await getMatmulSession()

    // X already row-major float32 [N, 512]. We need Xᵀ as B [512, N].
    // Transpose once up front — N can be up to 50 k → ~100 MB, fits in
    // host RAM easily, and avoids a per-chunk transpose.
    const Xt = new Float32Array(VEC_DIM * N)
    for (let i = 0; i < N; i++) {
        const base = i * VEC_DIM
        for (let k = 0; k < VEC_DIM; k++) {
            Xt[k * N + i] = X[base + k] as number
        }
    }
    const Bfull = new ort.Tensor('float32', Xt, [VEC_DIM, N])

    const edges: Array<[number, number]> = []
    const deg = new Array<number>(N).fill(0)

    let matmulMs = 0
    let thresholdMs = 0
    let chunks = 0

    await withMatmulLock(async () => {
        for (let rowStart = 0; rowStart < N; rowStart += chunkSize) {
            const rowEnd = Math.min(N, rowStart + chunkSize)
            const M = rowEnd - rowStart
            chunks++

            // Slice A: rows [rowStart, rowEnd) × 512.
            const aBytes = X.subarray(rowStart * VEC_DIM, rowEnd * VEC_DIM)
            const A = new ort.Tensor('float32', aBytes, [M, VEC_DIM])

            const tMm = performance.now()
            const out = await ms.session.run({
                [ms.inputAName]: A,
                [ms.inputBName]: Bfull,
            })
            const Y = out[ms.outputName]
            if (!Y) throw new Error('matmul session returned no output')
            const Ydata = Y.data as Float32Array
            matmulMs += performance.now() - tMm

            // Threshold + edge-emit. We only need i<j pairs, so each row i
            // (global index = rowStart + r) only considers columns j>i.
            const tTh = performance.now()
            for (let r = 0; r < M; r++) {
                const i = rowStart + r
                const rowBase = r * N
                for (let j = i + 1; j < N; j++) {
                    let s = Ydata[rowBase + j] as number
                    // Clamp to [-1,1] — float drift on cuBLAS can land at
                    // 1.0000001 for near-duplicate pairs.
                    if (s > 1) s = 1
                    else if (s < -1) s = -1
                    if (s >= threshold) {
                        edges.push([i, j])
                        deg[i] = (deg[i] ?? 0) + 1
                        deg[j] = (deg[j] ?? 0) + 1
                    }
                }
            }
            thresholdMs += performance.now() - tTh
        }
    })

    return { edges, deg, matmulMs, thresholdMs, chunks, ep: ms.ep }
}
