// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Provider-specific embedding adapters.
 *
 * Each adapter knows how to call one provider's embedding API.
 * The EmbeddingRouter selects which adapter to use based on workspace config.
 * No adapter is used directly — everything goes through the router.
 */

export interface EmbeddingAdapter {
    readonly providerId: string
    readonly model: string
    readonly dimensions: number
    embed(text: string): Promise<number[]>
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId = 'openai'
    readonly model: string
    readonly dimensions: number
    private apiKey: string
    private baseUrl: string

    constructor(apiKey: string, baseUrl = 'https://api.openai.com/v1', model = 'text-embedding-3-small', dimensions = 1536) {
        this.apiKey = apiKey
        this.baseUrl = baseUrl.replace(/\/+$/, '')
        this.model = model
        this.dimensions = dimensions
    }

    async embed(text: string): Promise<number[]> {
        const res = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.model, input: text.slice(0, 8192), dimensions: this.dimensions }),
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new Error(`OpenAI embedding API error ${res.status}: ${await res.text().catch(() => '')}`)
        const data = await res.json() as { data: Array<{ embedding: number[] }> }
        const vec = data.data[0]?.embedding
        if (!vec || vec.length !== this.dimensions) throw new Error(`OpenAI returned ${vec?.length ?? 0} dims, expected ${this.dimensions}`)
        return vec
    }
}

// ── Google (Gemini) ─────────────────────────────────────────────────────────

export class GoogleEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId = 'google'
    readonly model: string
    readonly dimensions: number
    private apiKey: string

    constructor(apiKey: string, model = 'text-embedding-004', dimensions = 768) {
        this.apiKey = apiKey
        this.model = model
        this.dimensions = dimensions
    }

    async embed(text: string): Promise<number[]> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: `models/${this.model}`, content: { parts: [{ text: text.slice(0, 8192) }] } }),
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new Error(`Google embedding API error ${res.status}: ${await res.text().catch(() => '')}`)
        const data = await res.json() as { embedding: { values: number[] } }
        const vec = data.embedding?.values
        if (!vec?.length) throw new Error('Google returned empty embedding')
        return vec
    }
}

// ── Mistral ─────────────────────────────────────────────────────────────────

export class MistralEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId = 'mistral'
    readonly model: string
    readonly dimensions: number
    private apiKey: string

    constructor(apiKey: string, model = 'mistral-embed', dimensions = 1024) {
        this.apiKey = apiKey
        this.model = model
        this.dimensions = dimensions
    }

    async embed(text: string): Promise<number[]> {
        const res = await fetch('https://api.mistral.ai/v1/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.model, input: [text.slice(0, 8192)] }),
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new Error(`Mistral embedding API error ${res.status}: ${await res.text().catch(() => '')}`)
        const data = await res.json() as { data: Array<{ embedding: number[] }> }
        const vec = data.data[0]?.embedding
        if (!vec?.length) throw new Error('Mistral returned empty embedding')
        return vec
    }
}

// ── Voyage AI ───────────────────────────────────────────────────────────────

export class VoyageEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId = 'voyage'
    readonly model: string
    readonly dimensions: number
    private apiKey: string

    constructor(apiKey: string, model = 'voyage-3', dimensions = 1024) {
        this.apiKey = apiKey
        this.model = model
        this.dimensions = dimensions
    }

    async embed(text: string): Promise<number[]> {
        const res = await fetch('https://api.voyageai.com/v1/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.model, input: [text.slice(0, 8192)] }),
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new Error(`Voyage embedding API error ${res.status}: ${await res.text().catch(() => '')}`)
        const data = await res.json() as { data: Array<{ embedding: number[] }> }
        const vec = data.data[0]?.embedding
        if (!vec?.length) throw new Error('Voyage returned empty embedding')
        return vec
    }
}

// ── Cohere ───────────────────────────────────────────────────────────────────

export class CohereEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId = 'cohere'
    readonly model: string
    readonly dimensions: number
    private apiKey: string

    constructor(apiKey: string, model = 'embed-english-v3.0', dimensions = 1024) {
        this.apiKey = apiKey
        this.model = model
        this.dimensions = dimensions
    }

    async embed(text: string): Promise<number[]> {
        const res = await fetch('https://api.cohere.com/v2/embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.model, texts: [text.slice(0, 8192)], input_type: 'search_document', embedding_types: ['float'] }),
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new Error(`Cohere embedding API error ${res.status}: ${await res.text().catch(() => '')}`)
        const data = await res.json() as { embeddings: { float: number[][] } }
        const vec = data.embeddings?.float?.[0]
        if (!vec?.length) throw new Error('Cohere returned empty embedding')
        return vec
    }
}

// ── Ollama (local) ──────────────────────────────────────────────────────────

/**
 * Default LLM model to unload before embedding. On CPU-only hosts Ollama
 * can't hold both a chat model and an embedding model in RAM simultaneously.
 * Override via OLLAMA_LLM_MODEL env var if using a different chat model.
 */
const OLLAMA_LLM_MODEL = process.env.OLLAMA_LLM_MODEL ?? 'llama3.2'

export class OllamaEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId: string
    readonly model: string
    readonly dimensions: number
    private baseUrl: string

    constructor(baseUrl: string, model = 'snowflake-arctic-embed', dimensions = 1024, providerId = 'ollama') {
        this.baseUrl = baseUrl.replace(/\/+$/, '')
        this.model = model
        this.dimensions = dimensions
        this.providerId = providerId
    }

    /**
     * Unload the active LLM model so Ollama has enough RAM to load the
     * embedding model. Uses keep_alive: 0 on a no-op generate call which
     * tells Ollama to immediately evict the model from memory.
     */
    private async unloadLLM(): Promise<void> {
        try {
            await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: OLLAMA_LLM_MODEL, keep_alive: 0 }),
                signal: AbortSignal.timeout(10_000),
            })
        } catch {
            // Best-effort — if the LLM isn't loaded this will 404/fail, which is fine.
        }
    }

    async embed(text: string): Promise<number[]> {
        if (!text.trim()) throw new Error('Cannot embed empty text')

        // On CPU-only hosts, unload the LLM first to free RAM for the embedding model.
        await this.unloadLLM()

        const url = `${this.baseUrl}/api/embed`
        const body = JSON.stringify({
            model: this.model,
            input: text.slice(0, 8192),
            keep_alive: '10m', // keep embedding model warm for subsequent calls
        })
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(120_000), // model load on CPU can take 30-60s
            redirect: 'manual' as const,
        }

        let res: Response
        try {
            res = await fetch(url, opts)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`Ollama embedding connection failed (url=${url}, model=${this.model}): ${msg}`)
        }

        // Handle HTTP→HTTPS redirect: fetch follows 301 but converts POST→GET,
        // causing 405. If we get a redirect, retry with the Location header directly.
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location')
            if (location) {
                res = await fetch(location, { ...opts, redirect: 'follow' })
            }
        }

        if (!res.ok) throw new Error(`Ollama embedding error ${res.status} (url=${url}): ${await res.text().catch(() => '')}`)
        const data = await res.json() as { embeddings: number[][] }
        const vec = data.embeddings?.[0]
        if (!vec?.length) throw new Error(`Ollama returned empty embedding (url=${url}, model=${this.model})`)
        return vec
    }
}

// ── OpenRouter (proxied embeddings) ─────────────────────────────────────────

export class OpenRouterEmbeddingAdapter implements EmbeddingAdapter {
    readonly providerId = 'openrouter'
    readonly model: string
    readonly dimensions: number
    private apiKey: string

    constructor(apiKey: string, model = 'openai/text-embedding-3-small', dimensions = 1536) {
        this.apiKey = apiKey
        this.model = model
        this.dimensions = dimensions
    }

    async embed(text: string): Promise<number[]> {
        // OpenRouter proxies to OpenAI's embedding endpoint
        const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.model, input: text.slice(0, 8192) }),
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new Error(`OpenRouter embedding API error ${res.status}: ${await res.text().catch(() => '')}`)
        const data = await res.json() as { data: Array<{ embedding: number[] }> }
        const vec = data.data[0]?.embedding
        if (!vec?.length) throw new Error('OpenRouter returned empty embedding')
        return vec
    }
}

// ── Gateway (Plexo native ONNX embeddings) ───────────────────────────────

/**
 * Calls the Plexo Inference Gateway's /v1/embeddings endpoint.
 * Highest-priority adapter — zero external dependencies, zero API cost.
 * The gateway runs snowflake-arctic-embed via ONNX Runtime natively.
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

/** Providers known to support embeddings. Others are assumed to NOT support them. */
export const EMBEDDING_CAPABLE_PROVIDERS = new Set([
    'plexo-gateway',
    'openai',
    'google',
    'mistral',
    'voyage',
    'cohere',
    'ollama',
    'ollama_cloud',
    'openrouter',
])

/** Providers that definitely do NOT have embedding endpoints. */
export const EMBEDDING_INCAPABLE_PROVIDERS = new Set([
    'anthropic', // Use Voyage AI (Anthropic-recommended pairing)
    'deepseek',  // No embedding endpoint as of 2026-04
    'groq',      // Inference-only
    'xai',       // No embedding endpoint
])

/** Default embedding model per provider. */
export const DEFAULT_EMBEDDING_MODELS: Record<string, { model: string; dimensions: number }> = {
    'plexo-gateway': { model: 'plexo-embed-v1', dimensions: 384 },
    openai: { model: 'text-embedding-3-small', dimensions: 1536 },
    google: { model: 'text-embedding-004', dimensions: 768 },
    mistral: { model: 'mistral-embed', dimensions: 1024 },
    voyage: { model: 'voyage-3', dimensions: 1024 },
    cohere: { model: 'embed-english-v3.0', dimensions: 1024 },
    ollama: { model: 'snowflake-arctic-embed', dimensions: 1024 },
    ollama_cloud: { model: 'snowflake-arctic-embed', dimensions: 1024 },
    openrouter: { model: 'openai/text-embedding-3-small', dimensions: 1536 },
}
