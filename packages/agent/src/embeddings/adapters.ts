// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Embedding adapters.
 *
 * Collapsed 2026-06-27 (operator panel 5/5): canonical embedding path is the
 * bundled Plexo Inference Gateway (`apps/embeddings/`) — a self-hosted 384-d
 * ONNX service. BYOK cloud SDK adapters and in-process / Ollama HTTP
 * adapters were removed; stored vectors are `vector(384)` with HNSW indexes,
 * and a single dimension-safe path eliminates the re-embed/index-rebuild
 * blast radius any other provider would introduce.
 *
 * The HashEmbeddingAdapter is retained as a last-resort deterministic
 * fallback used only when the caller explicitly asks for it (no semantic
 * content; never picked by the router).
 */

export interface EmbeddingAdapter {
    readonly providerId: string
    readonly model: string
    readonly dimensions: number
    embed(text: string): Promise<number[]>
}

// ── Gateway (Plexo native ONNX embeddings) ───────────────────────────────

/**
 * Calls the Plexo Inference Gateway's /v1/embeddings endpoint.
 * The gateway runs snowflake-arctic-embed-s via ONNX Runtime natively.
 * 384-d output. Dim-locked to match stored vector(384) columns.
 */
export class GatewayEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId = 'plexo-gateway'
    readonly model: string
    readonly dimensions: number
    private baseUrl: string

    constructor(baseUrl: string, model = 'plexo-embed-v1', dimensions = 384) {
        this.baseUrl = baseUrl.replace(/\/+$/, '')
        this.model = model
        this.dimensions = dimensions
    }

    async embed(text: string): Promise<number[]> {
        if (!text.trim()) throw new Error('Cannot embed empty text')

        const url = `${this.baseUrl}/v1/embeddings`
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: text.slice(0, 8192), model: this.model }),
            signal: AbortSignal.timeout(15_000),
        })

        if (!res.ok) {
            throw new Error(`Gateway embedding error ${res.status} (url=${url}): ${await res.text().catch(() => '')}`)
        }

        const data = await res.json() as { data: Array<{ embedding: number[] }> }
        const vec = data.data[0]?.embedding
        if (!vec?.length) throw new Error(`Gateway returned empty embedding (url=${url})`)
        return vec
    }
}

// ── Hash fallback (NO semantic content — last resort only) ──────────────────

export class HashEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId = 'hash-fallback'
    readonly model = 'deterministic-hash'
    readonly dimensions: number

    constructor(dimensions = 256) {
        this.dimensions = dimensions
    }

    async embed(text: string): Promise<number[]> {
        return hashToVector(text, this.dimensions)
    }
}

function hashToVector(text: string, dims: number): number[] {
    const v = new Array<number>(dims).fill(0)
    const lower = text.toLowerCase()
    for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < lower.length; i++) {
            const code = lower.charCodeAt(i)
            const hash = ((code * 31 + i * 17 + pass * 7919) * 2654435761) >>> 0
            const idx = hash % dims
            const sign = (hash >> 16) & 1 ? 1 : -1
            v[idx]! += sign * (1 / (pass + 1))
        }
    }
    let mag = 0
    for (const x of v) mag += x * x
    mag = Math.sqrt(mag)
    if (mag > 0) for (let i = 0; i < dims; i++) v[i] = v[i]! / mag
    return v
}

// ── Provider capability map ─────────────────────────────────────────────────

export type EmbeddingProviderStatus = 'active' | 'not-configured' | 'credential-invalid' | 'fallback-hash'

/**
 * Providers known to support embeddings. After the 2026-06-27 collapse this
 * is just the bundled gateway — other entries are kept for type/string
 * consumers (e.g. provider discovery for custom OpenAI-compatible endpoints
 * the operator might wire up), but the router will not pick them.
 */
export const EMBEDDING_CAPABLE_PROVIDERS = new Set([
    'plexo-gateway',
])

/** Providers that definitely do NOT have embedding endpoints. */
export const EMBEDDING_INCAPABLE_PROVIDERS = new Set([
    'anthropic',
    'deepseek',
    'groq',
    'xai',
])

/** Default embedding model per provider. Only the gateway is wired. */
export const DEFAULT_EMBEDDING_MODELS: Record<string, { model: string; dimensions: number }> = {
    'plexo-gateway': { model: 'plexo-embed-v1', dimensions: 384 },
}
