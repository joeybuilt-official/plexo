// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Singleton ONNX Runtime session over a tiny dynamic-shape MatMul graph.
 *
 * Used by `/v1/faces/cluster` to compute pairwise cosine similarity on the
 * GPU as X · Xᵀ (face vectors are already L2-normalised). One session,
 * lazy-booted on first request, reused for the lifetime of the process.
 *
 * The CLIP + face-detect/recognise sessions already share the same 12 GB
 * RTX 3060 with this one — CLIP alone holds ~11 GB resident. To prevent
 * collisions on the device, callers must run their session.run() through
 * `withMatmulLock()` (a process-wide async mutex). The mutex is local to
 * this module; callers don't manage the lock directly.
 *
 * Graph (matmul_t.onnx, ~140 bytes):
 *   A: float32 [M, 512]   (dynamic M)
 *   B: float32 [512, N]   (dynamic N)
 *   Y: float32 [M, N]     (= A @ B)
 *
 * Execution provider follows the existing convention from
 * apps/vision/src/models/faces.ts: VISION_ORT_EP=cuda → ['cuda','cpu']
 * with per-op CPU fallback. Default 'cpu' so CPU-only hosts keep working.
 */

import * as ort from 'onnxruntime-node'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { childLogger } from './logger.js'

const logger = childLogger('matmul-session')

// `apps/vision/src/lib/matmulSession.ts` → `apps/vision/models/matmul_t.onnx`
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MATMUL_ONNX_PATH = resolve(__dirname, '../../models/matmul_t.onnx')

export interface MatmulSession {
    session: ort.InferenceSession
    inputAName: string
    inputBName: string
    outputName: string
    ep: 'cuda' | 'cpu'
}

let session: MatmulSession | null = null
let loadingPromise: Promise<MatmulSession> | null = null

async function load(): Promise<MatmulSession> {
    if (session) return session
    if (loadingPromise) return loadingPromise
    loadingPromise = (async () => {
        const ortEp: string[] =
            process.env.VISION_ORT_EP === 'cuda' ? ['cuda', 'cpu'] : ['cpu']
        const t0 = performance.now()
        logger.info({ path: MATMUL_ONNX_PATH, ortEp }, 'Loading matmul_t.onnx')
        const s = await ort.InferenceSession.create(MATMUL_ONNX_PATH, {
            executionProviders: ortEp,
            graphOptimizationLevel: 'all',
        })
        const inputs = [...s.inputNames]
        const outputs = [...s.outputNames]
        // Graph inputs are 'A' and 'B' but we use the session-reported
        // names so a future model swap doesn't silently mismatch keys.
        const inputAName = inputs[0] ?? 'A'
        const inputBName = inputs[1] ?? 'B'
        const outputName = outputs[0] ?? 'Y'
        const built: MatmulSession = {
            session: s,
            inputAName,
            inputBName,
            outputName,
            ep: process.env.VISION_ORT_EP === 'cuda' ? 'cuda' : 'cpu',
        }
        session = built
        loadingPromise = null
        logger.info(
            {
                loadMs: Math.round(performance.now() - t0),
                inputs,
                outputs,
                ep: built.ep,
            },
            'Matmul session ready',
        )
        return built
    })()
    return loadingPromise
}

export async function getMatmulSession(): Promise<MatmulSession> {
    return load()
}

// Simple promise-chain mutex — every withMatmulLock() awaits the previous
// one. Cheap and correct for our throughput (one cluster call at a time
// while CLIP/face-detect run their own GPU jobs).
let lockTail: Promise<unknown> = Promise.resolve()

export async function withMatmulLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lockTail
    let release: () => void = () => {}
    const slot = new Promise<void>((res) => {
        release = res
    })
    lockTail = slot
    try {
        await prev
        return await fn()
    } finally {
        release()
    }
}
