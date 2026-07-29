// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Generic OllamaAdapter — serves both LLM chat and embedding calls
 * from a single Ollama instance URL.
 *
 * The same class is used for:
 * - Managed Ollama sidecar (OLLAMA_INTERNAL_URL)
 * - User-added self-hosted Ollama (workspace vault base URL)
 * - User-added Ollama Cloud (ollama.com)
 *
 * The only difference between instances is the endpoint URL and credentials.
 */

import pino from 'pino'
import { classifyModel, getEmbeddingDimensions, type ModelCapability } from './classify-model.js'

const logger = pino({ name: 'ollama:adapter' })

export interface OllamaModel {
    name: string
    sizeMb: number
    capability: ModelCapability
    embeddingDimensions: number | null
    family: string | null
}

export interface OllamaCapabilities {
    supportsChat: boolean
    supportsEmbeddings: boolean
    chatModels: string[]
    embeddingModels: string[]
    allModels: OllamaModel[]
}

export interface OllamaChatMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export interface OllamaChatResponse {
    model: string
    message: { role: string; content: string }
    done: boolean
    total_duration?: number
    eval_count?: number
    prompt_eval_count?: number
}

export interface OllamaEmbedResponse {
    model: string
    embeddings: number[][]
}

export class OllamaAdapter {
    readonly id: string
    readonly endpoint: string
    private auth: string | null
    private _capabilities: OllamaCapabilities | null = null
    private _lastDiscovery: number = 0
    private _discoveryPromise: Promise<OllamaCapabilities> | null = null

    constructor(params: {
        id: string
        endpoint: string
        auth?: string | null
    }) {
        this.id = params.id
        this.endpoint = params.endpoint.replace(/\/+$/, '')
        this.auth = params.auth ?? null
    }

    get capabilities(): OllamaCapabilities | null {
        return this._capabilities
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = { 'Content-Type': 'application/json' }
        if (this.auth) h['Authorization'] = `Bearer ${this.auth}`
        return h
    }

    /**
     * Discover available models and classify capabilities.
     * Deduplicates concurrent calls — only one network request in flight at a time.
     */
    async discoverCapabilities(): Promise<OllamaCapabilities> {
        // Deduplicate concurrent discovery calls
        if (this._discoveryPromise) return this._discoveryPromise
        this._discoveryPromise = this._doDiscovery()
        try {
            return await this._discoveryPromise
        } finally {
            this._discoveryPromise = null
        }
    }

    private async _doDiscovery(): Promise<OllamaCapabilities> {
        const url = `${this.endpoint}/api/tags`
        try {
            const res = await fetch(url, {
                headers: this.headers(),
                signal: AbortSignal.timeout(10_000),
                redirect: 'manual',
            })

            // Handle HTTP→HTTPS redirect
            let finalRes = res
            if (res.status >= 300 && res.status < 400) {
                const location = res.headers.get('location')
                if (location) {
                    finalRes = await fetch(location, {
                        headers: this.headers(),
                        signal: AbortSignal.timeout(10_000),
                    })
                }
            }

            if (!finalRes.ok) throw new Error(`Ollama returned ${finalRes.status}`)

            const data = await finalRes.json() as {
                models: Array<{
                    name: string
                    size: number
                    details?: { family?: string }
                }>
            }

            const allModels: OllamaModel[] = (data.models ?? []).map(m => ({
                name: m.name,
                sizeMb: Math.round(m.size / 1024 / 1024),
                capability: classifyModel(m.name),
                embeddingDimensions: getEmbeddingDimensions(m.name),
                family: m.details?.family ?? null,
            }))

            const chatModels = allModels.filter(m => m.capability === 'chat' || m.capability === 'both').map(m => m.name)
            const embeddingModels = allModels.filter(m => m.capability === 'embedding' || m.capability === 'both').map(m => m.name)

            this._capabilities = {
                supportsChat: chatModels.length > 0,
                supportsEmbeddings: embeddingModels.length > 0,
                chatModels,
                embeddingModels,
                allModels,
            }
            this._lastDiscovery = Date.now()

            logger.info({
                id: this.id,
                chatModels: chatModels.length,
                embeddingModels: embeddingModels.length,
                total: allModels.length,
            }, 'Ollama capability discovery complete')

            return this._capabilities
        } catch (err) {
            logger.warn({ err, id: this.id, url }, 'Ollama capability discovery failed')
            this._capabilities = {
                supportsChat: false,
                supportsEmbeddings: false,
                chatModels: [],
                embeddingModels: [],
                allModels: [],
            }
            return this._capabilities
        }
    }

    /**
     * Re-discover if stale (older than 15 minutes).
     */
    async ensureFresh(): Promise<OllamaCapabilities> {
        if (!this._capabilities || Date.now() - this._lastDiscovery > 15 * 60 * 1000) {
            return this.discoverCapabilities()
        }
        return this._capabilities
    }

    /**
     * Send a chat completion request.
     */
    async chat(params: {
        model: string
        messages: OllamaChatMessage[]
        stream?: boolean
    }): Promise<OllamaChatResponse> {
        const body = JSON.stringify({
            model: params.model,
            messages: params.messages,
            stream: params.stream ?? false,
        })

        const res = await this.post('/api/chat', body)
        return await res.json() as OllamaChatResponse
    }

    /**
     * Generate embeddings.
     * If model is not specified, uses the first available embedding model.
     *
     * On CPU-only hosts, Ollama can't hold both a chat model and an embedding
     * model in RAM simultaneously. Before embedding, we unload any loaded chat
     * model (keep_alive: 0) to free memory, and set keep_alive on the embed
     * call so the embedding model stays warm for subsequent requests.
     */
    async embed(text: string, model?: string): Promise<{ vector: number[]; model: string; dimensions: number }> {
        const caps = await this.ensureFresh()
        const embModel = model ?? caps.embeddingModels[0]
        if (!embModel) throw new Error(`No embedding model available on Ollama instance ${this.id}`)

        // Unload any loaded chat model to free RAM for the embedding model.
        await this.unloadChatModels(caps)

        // Truncate to 2048 chars — embedding models produce best results on shorter texts
        // and Ollama is slow on very long inputs (>8K chars can timeout)
        const body = JSON.stringify({
            model: embModel,
            input: text.slice(0, 2048),
            keep_alive: '10m',
        })
        const res = await this.post('/api/embed', body, 120_000)
        const data = await res.json() as OllamaEmbedResponse
        const vec = data.embeddings?.[0]
        if (!vec?.length) throw new Error('Ollama returned empty embedding')

        return { vector: vec, model: embModel, dimensions: vec.length }
    }

    /**
     * Unload chat models to free RAM before loading the embedding model.
     * Best-effort — failures are silently ignored.
     */
    private async unloadChatModels(caps: OllamaCapabilities): Promise<void> {
        const llmModel = process.env.OLLAMA_LLM_MODEL ?? caps.chatModels[0]
        if (!llmModel) return
        try {
            await fetch(`${this.endpoint}/api/generate`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ model: llmModel, keep_alive: 0 }),
                signal: AbortSignal.timeout(10_000),
            })
        } catch {
            // Best-effort — model may not be loaded, which is fine.
        }
    }

    /**
     * Get embedding dimensions for a model.
     */
    dimensions(model?: string): number | null {
        const caps = this._capabilities
        if (!caps) return null
        const embModel = model ?? caps.embeddingModels[0]
        if (!embModel) return null
        return getEmbeddingDimensions(embModel)
    }

    /**
     * Check if the instance is reachable.
     */
    async isHealthy(): Promise<boolean> {
        try {
            const res = await fetch(`${this.endpoint}/api/tags`, {
                headers: this.headers(),
                signal: AbortSignal.timeout(5_000),
                redirect: 'manual',
            })
            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get('location')
                if (loc) {
                    const r2 = await fetch(loc, { headers: this.headers(), signal: AbortSignal.timeout(5_000) })
                    return r2.ok
                }
            }
            return res.ok
        } catch {
            return false
        }
    }

    private async post(path: string, body: string, timeoutMs = 60_000): Promise<Response> {
        const url = `${this.endpoint}${path}`
        const opts: RequestInit = {
            method: 'POST',
            headers: this.headers(),
            body,
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'manual' as const,
        }

        let res = await fetch(url, opts)

        // Handle HTTP→HTTPS redirect preserving POST
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location')
            if (location) {
                res = await fetch(location, { ...opts, redirect: 'follow' })
            }
        }

        if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw new Error(`Ollama ${path} error ${res.status}: ${text.slice(0, 200)}`)
        }

        return res
    }
}
