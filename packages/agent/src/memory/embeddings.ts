// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * `memory.embeddings.*` — first-class shared embeddings capability.
 *
 * Promotes the existing Xenova-backed embedder (committed in 1da6807, Phase
 * 1+2 unified knowledge graph) into a single entry point that BOTH the
 * synthesis loop AND the SCL concept-graph layer consume. No fork of the
 * embedding stack: this file is a thin façade over `embeddings/router.ts`
 * with a tiny in-process LRU so repeated identical-text calls during a
 * single clustering pass don't re-run the ONNX model.
 *
 * API contract (also exposed via HTTP at `POST /api/v1/memory/embeddings`):
 *
 *   embed(text)                  → Float32Array
 *   embed([text, text, ...])     → Float32Array[]
 *   embedAsArray(text)           → number[]      (JSON-friendly)
 *   embedAsArrays(strings)       → number[][]
 *
 * Empty / whitespace-only inputs return a zero vector at the resolved
 * adapter's dimension count — same contract every existing adapter ships.
 *
 * Provider resolution: the embedding router is collapsed to a single
 * gateway path (Plexo Inference Gateway, 384-d). Callers that need a
 * specific workspace just pass `workspaceId` — it's threaded through for
 * logging but the resolved adapter is identical across workspaces.
 */
import pino from 'pino'
import {
    resolveEmbeddingAdapterAsync,
    type EmbeddingAdapter,
    type EmbeddingRouterResult,
} from '../embeddings/router.js'

const logger = pino({ name: 'memory:embeddings' })

const SYSTEM_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000'
const CACHE_MAX = 1024
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
    vector: Float32Array
    expiresAt: number
}

/* ── Tiny LRU keyed on (providerId, text) ─────────────────────────────── */

const cache = new Map<string, CacheEntry>()

function cacheKey(providerId: string, text: string): string {
    return `${providerId}::${text}`
}

function cacheGet(key: string): Float32Array | null {
    const hit = cache.get(key)
    if (!hit) return null
    if (hit.expiresAt < Date.now()) {
        cache.delete(key)
        return null
    }
    // Bump for LRU
    cache.delete(key)
    cache.set(key, hit)
    return hit.vector
}

function cachePut(key: string, vec: Float32Array): void {
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest) cache.delete(oldest)
    }
    cache.set(key, { vector: vec, expiresAt: Date.now() + CACHE_TTL_MS })
}

/* ── Public API ───────────────────────────────────────────────────────── */

export interface EmbedOptions {
    /** Workspace id used for provider resolution. Defaults to the system
     *  workspace which forces the Xenova path (no per-workspace key lookup). */
    workspaceId?: string
    /** Bypass cache. Default false. */
    skipCache?: boolean
}

export interface EmbedResolution {
    providerId: string
    model: string
    dimensions: number
}

/**
 * Embed a single string OR an array of strings. Result type matches the
 * input arity. Throws if no embedding provider is resolvable for the
 * workspace — callers must pre-check via `getEmbedder` if they want a
 * graceful fallback.
 */
export async function embed(text: string, opts?: EmbedOptions): Promise<Float32Array>
export async function embed(text: string[], opts?: EmbedOptions): Promise<Float32Array[]>
export async function embed(
    text: string | string[],
    opts?: EmbedOptions,
): Promise<Float32Array | Float32Array[]> {
    const { adapter } = await resolveOrThrow(opts?.workspaceId)
    if (Array.isArray(text)) {
        const out: Float32Array[] = []
        for (const t of text) out.push(await embedOne(adapter, t, opts?.skipCache))
        return out
    }
    return embedOne(adapter, text, opts?.skipCache)
}

/** number[]-typed convenience for JSON serialisation (HTTP endpoints). */
export async function embedAsArray(text: string, opts?: EmbedOptions): Promise<number[]> {
    const v = await embed(text, opts)
    return Array.from(v)
}

export async function embedAsArrays(items: string[], opts?: EmbedOptions): Promise<number[][]> {
    const vs = await embed(items, opts)
    return vs.map(v => Array.from(v))
}

/** Resolve once; return the adapter and lineage metadata so callers can
 *  decide whether to short-circuit. Mirrors the SCL embedding-provider
 *  contract so existing code paths can be replaced one-by-one. */
export async function getEmbedder(workspaceId?: string): Promise<{
    adapter: EmbeddingAdapter
    resolution: EmbeddingRouterResult
}> {
    return resolveOrThrow(workspaceId)
}

/* ── Internals ────────────────────────────────────────────────────────── */

async function resolveOrThrow(workspaceId?: string): Promise<{
    adapter: EmbeddingAdapter
    resolution: EmbeddingRouterResult
}> {
    const wsid = workspaceId ?? SYSTEM_WORKSPACE_ID
    const resolution = await resolveEmbeddingAdapterAsync(wsid)
    if (!resolution.adapter || resolution.status !== 'active') {
        const err = new Error(
            `No embedding provider available (status=${resolution.status}). ` +
            `The bundled embeddings gateway should be running; check EMBEDDINGS_URL and the embeddings docker-compose service.`,
        )
        ;(err as Error & { code?: string }).code = 'NO_EMBEDDER'
        throw err
    }
    return { adapter: resolution.adapter, resolution }
}

async function embedOne(adapter: EmbeddingAdapter, text: string, skipCache?: boolean): Promise<Float32Array> {
    const trimmed = text ?? ''
    const dims = adapter.dimensions
    if (!trimmed.trim()) return new Float32Array(dims)

    const key = cacheKey(adapter.providerId, trimmed)
    if (!skipCache) {
        const hit = cacheGet(key)
        if (hit) return hit
    }

    let vec: number[]
    try {
        vec = await adapter.embed(trimmed)
    } catch (err) {
        logger.warn({ err, providerId: adapter.providerId }, 'embed failed')
        throw err
    }
    if (vec.length !== dims) {
        throw new Error(`embed: adapter returned ${vec.length} dims, expected ${dims}`)
    }
    const out = new Float32Array(dims)
    for (let i = 0; i < dims; i++) out[i] = vec[i] ?? 0
    if (!skipCache) cachePut(key, out)
    return out
}

/** Test seam — clears the in-process cache. Production code never calls this. */
export function _resetEmbeddingsCache(): void {
    cache.clear()
}
