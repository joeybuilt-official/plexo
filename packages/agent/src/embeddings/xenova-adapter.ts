// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Xenova/multilingual-e5-small adapter — pure-JS ONNX embedder.
 *
 * 384-dim, multilingual. Locked as Plexo's default embedder per
 * Phase 1 of the unified Knowledge Graph plan: it removes a whole
 * failure class (no provider outage can starve memory writes) and
 * keeps `vector(384)` columns valid.
 *
 * Loads lazily on first call so cold-start of unrelated paths isn't
 * burdened. Singleton per-process — the ~470 MB model file is
 * downloaded into the local HF cache on first use.
 *
 * The model is the e5 family which expects an instruction prefix:
 *   passages → "passage: <text>"
 *   queries  → "query: <text>"
 * We always use "passage:" because storeMemory and clusterMemory
 * are passage-side. Search-side queries embed via the same call —
 * for now the asymmetry is small enough not to matter; if recall
 * sags later, add a `kind: 'query'|'passage'` flag.
 */
import pino from 'pino'
import type { EmbeddingAdapter } from './adapters.js'

const logger = pino({ name: 'embeddings:xenova' })

const MODEL_ID = 'Xenova/multilingual-e5-small'
const DIMENSIONS = 384
const PROVIDER_ID = 'xenova-multilingual-e5-small'

/* eslint-disable @typescript-eslint/no-explicit-any */
type PipelineFn = (text: string, opts: { pooling: 'mean'; normalize: true }) => Promise<{ data: Float32Array | number[] }>
let _pipelinePromise: Promise<PipelineFn> | null = null

async function getPipeline(): Promise<PipelineFn> {
    if (_pipelinePromise) return _pipelinePromise
    _pipelinePromise = (async () => {
        // Dynamic import to avoid pulling the model loader into cold-start
        // paths that don't touch embeddings.
        const mod: any = await import('@xenova/transformers')
        // Disable remote model fetch in production once the cache is warm —
        // controlled via env so first run can still download.
        if (process.env.XENOVA_OFFLINE === '1' && mod.env) {
            mod.env.allowRemoteModels = false
        }
        // Cache dir override — useful when embedding inside a container
        // with a mounted volume so model downloads survive rebuilds.
        if (process.env.XENOVA_CACHE_DIR && mod.env) {
            mod.env.cacheDir = process.env.XENOVA_CACHE_DIR
        }
        logger.info({ model: MODEL_ID, cacheDir: mod.env?.cacheDir }, 'loading xenova embedder')
        const pipe = await mod.pipeline('feature-extraction', MODEL_ID)
        logger.info({ model: MODEL_ID }, 'xenova embedder ready')
        return pipe as PipelineFn
    })()
    try {
        return await _pipelinePromise
    } catch (err) {
        // On failure, clear the cached promise so the next caller retries.
        _pipelinePromise = null
        throw err
    }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class XenovaEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId = PROVIDER_ID
    readonly model = MODEL_ID
    readonly dimensions = DIMENSIONS

    async embed(text: string): Promise<number[]> {
        if (!text || !text.trim()) {
            // Return a zero vector for empty text — caller decides whether
            // to persist. This matches the contract of other adapters,
            // which would also produce something useless on empty input.
            return new Array<number>(DIMENSIONS).fill(0)
        }
        const pipe = await getPipeline()
        const output = await pipe(`passage: ${text.slice(0, 8192)}`, { pooling: 'mean', normalize: true })
        const data = output?.data
        if (!data || data.length !== DIMENSIONS) {
            throw new Error(`xenova returned ${data?.length ?? 0} dims, expected ${DIMENSIONS}`)
        }
        // Float32Array → number[] for downstream JSON serialization.
        const arr = new Array<number>(DIMENSIONS)
        for (let i = 0; i < DIMENSIONS; i++) arr[i] = (data as Float32Array)[i] ?? 0
        return arr
    }
}

/**
 * Sanity-check assertion run at startup (called from router.ts on first
 * resolution). Embeds a short phrase; throws if dimensions ≠ 384.
 *
 * Idempotent — tracked via a module-level boolean so we never block more
 * than once even if multiple callers invoke during boot.
 */
let _asserted = false
export async function assertDefaultEmbedderDimensions(): Promise<void> {
    if (_asserted) return
    const adapter = new XenovaEmbeddingAdapter()
    const vec = await adapter.embed('plexo embedding floor')
    if (vec.length !== DIMENSIONS) {
        throw new Error(`embedding floor violation: default embedder produced ${vec.length}-d vector (expected ${DIMENSIONS})`)
    }
    _asserted = true
}
