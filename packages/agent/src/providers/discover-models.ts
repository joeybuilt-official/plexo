// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Runtime model discovery for provider instances.
 *
 * Given a provider type + credentials, hit that provider's model-listing
 * endpoint and return the live set of chat models the caller's API key
 * actually has access to. This replaces the hardcoded per-provider catalog
 * on the settings page — the previous behavior caused "API key doesn't have
 * permission for this model" errors because the UI's first-pill model was
 * hardcoded and might not be in the user's tier.
 *
 * Every edge soft-fails: on network error, 401/403, timeout, or malformed
 * response we return { ok: false, error, fallbackModels } so the UI still
 * has something to show (the old hardcoded list, treated as a hint).
 */

import pino from 'pino'

const logger = pino({ name: 'provider:discover-models' })

const DISCOVERY_TIMEOUT_MS = 5_000

export interface DiscoveredModel {
    id: string
    contextWindow?: number
    capabilities?: string[]
}

export type DiscoveryResult =
    | { ok: true; models: DiscoveredModel[] }
    | { ok: false; error: string; fallbackModels: string[] }

export interface DiscoverCredentials {
    apiKey?: string
    baseUrl?: string
}

/**
 * Hardcoded fallback model lists — used as the UI's "AVAILABLE MODELS" hint
 * when live discovery fails (or is not supported for this provider, e.g.
 * Cloudflare Workers AI and Voyage which have no public list endpoint).
 *
 * When discovery succeeds, the live list is authoritative. These are hints.
 */
export const FALLBACK_MODELS: Record<string, string[]> = {
    openai: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
    anthropic: ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    google: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    cerebras: ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507', 'gpt-oss-120b', 'zai-glm-4.7'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    mistral: ['mistral-large-latest', 'mistral-small-latest'],
    xai: ['grok-3', 'grok-3-mini'],
    openrouter: ['deepseek/deepseek-chat-v3-0324:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    fireworks: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    perplexity: ['sonar', 'sonar-pro'],
    cohere: ['command-a-03-2025', 'command-r-plus', 'command-r'],
    sambanova: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct'],
    cloudflare: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    voyage: ['voyage-3'],
    ollama: [],
    ollama_cloud: ['gpt-oss:120b', 'gpt-oss:20b', 'deepseek-v3.2', 'qwen3-coder:480b', 'gemma4:31b'],
}

/**
 * Providers with no public list endpoint — always return their hardcoded hints
 * as "fallback" and mark ok=false so the UI keeps treating them as static.
 */
const STATIC_ONLY_PROVIDERS = new Set<string>(['cloudflare', 'voyage', 'sambanova'])

function fallback(providerType: string, error: string): DiscoveryResult {
    return {
        ok: false,
        error,
        fallbackModels: FALLBACK_MODELS[providerType] ?? [],
    }
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), DISCOVERY_TIMEOUT_MS)
    try {
        return await fetch(url, { ...init, signal: ac.signal })
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Pull `.data[]` from an OpenAI-compatible `/v1/models` response.
 * Shape: { data: [{ id: "gpt-4o", ... }, ...] } or occasionally a bare array.
 */
function parseOpenAICompatibleModels(raw: unknown): DiscoveredModel[] {
    const root = raw as { data?: unknown[] } | unknown[]
    const arr = Array.isArray(root)
        ? root
        : Array.isArray((root as { data?: unknown[] }).data)
            ? (root as { data: unknown[] }).data
            : []
    const models: DiscoveredModel[] = []
    for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Record<string, unknown>
        const id = typeof e.id === 'string' ? e.id
            : typeof e.name === 'string' ? e.name
                : null
        if (!id) continue
        const ctx = typeof e.context_length === 'number' ? e.context_length
            : typeof e.context_window === 'number' ? e.context_window
                : typeof e.max_context_length === 'number' ? e.max_context_length
                    : undefined
        models.push({ id, contextWindow: ctx })
    }
    return models
}

async function discoverOpenAICompatible(
    providerType: string,
    baseUrl: string,
    apiKey: string,
    extraHeaders: Record<string, string> = {},
): Promise<DiscoveryResult> {
    if (!apiKey) return fallback(providerType, 'API key required')
    try {
        const res = await timedFetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                ...extraHeaders,
            },
        })
        if (!res.ok) {
            return fallback(providerType, `Provider returned ${res.status}`)
        }
        const raw = await res.json().catch(() => null)
        if (!raw) return fallback(providerType, 'Malformed response')
        const models = parseOpenAICompatibleModels(raw)
        return { ok: true, models }
    } catch (err) {
        const message = err instanceof Error
            ? (err.name === 'AbortError' ? 'Discovery timed out' : err.message)
            : 'Discovery failed'
        return fallback(providerType, message.slice(0, 200))
    }
}

async function discoverAnthropic(apiKey: string): Promise<DiscoveryResult> {
    if (!apiKey) return fallback('anthropic', 'API key required')
    try {
        const res = await timedFetch('https://api.anthropic.com/v1/models', {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                Accept: 'application/json',
            },
        })
        if (!res.ok) return fallback('anthropic', `Provider returned ${res.status}`)
        const raw = await res.json().catch(() => null) as { data?: Array<{ id: string }> } | null
        if (!raw || !Array.isArray(raw.data)) return fallback('anthropic', 'Malformed response')
        const models: DiscoveredModel[] = raw.data
            .filter(m => m && typeof m.id === 'string')
            .map(m => ({ id: m.id }))
        return { ok: true, models }
    } catch (err) {
        const message = err instanceof Error
            ? (err.name === 'AbortError' ? 'Discovery timed out' : err.message)
            : 'Discovery failed'
        return fallback('anthropic', message.slice(0, 200))
    }
}

async function discoverGoogle(apiKey: string): Promise<DiscoveryResult> {
    if (!apiKey) return fallback('google', 'API key required')
    try {
        const res = await timedFetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
            { headers: { Accept: 'application/json' } },
        )
        if (!res.ok) return fallback('google', `Provider returned ${res.status}`)
        const raw = await res.json().catch(() => null) as {
            models?: Array<{
                name: string
                supportedGenerationMethods?: string[]
                inputTokenLimit?: number
            }>
        } | null
        if (!raw || !Array.isArray(raw.models)) return fallback('google', 'Malformed response')
        // Google returns names like "models/gemini-2.5-flash" — strip the prefix.
        // Only keep models that support generateContent (chat).
        const models: DiscoveredModel[] = raw.models
            .filter(m => m && typeof m.name === 'string')
            .filter(m => !m.supportedGenerationMethods
                || m.supportedGenerationMethods.includes('generateContent'))
            .map(m => ({
                id: m.name.replace(/^models\//, ''),
                contextWindow: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined,
            }))
        return { ok: true, models }
    } catch (err) {
        const message = err instanceof Error
            ? (err.name === 'AbortError' ? 'Discovery timed out' : err.message)
            : 'Discovery failed'
        return fallback('google', message.slice(0, 200))
    }
}

async function discoverOllama(providerType: string, baseUrl: string, apiKey?: string): Promise<DiscoveryResult> {
    const endpoint = (baseUrl || (providerType === 'ollama_cloud' ? 'https://ollama.com' : '')).replace(/\/+$/, '')
    if (!endpoint) return fallback(providerType, 'baseUrl required for Ollama discovery')
    try {
        const headers: Record<string, string> = { Accept: 'application/json' }
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
        const res = await timedFetch(`${endpoint}/api/tags`, { headers })
        if (!res.ok) return fallback(providerType, `Provider returned ${res.status}`)
        const raw = await res.json().catch(() => null) as {
            models?: Array<{ name: string; size?: number }>
        } | null
        if (!raw || !Array.isArray(raw.models)) return fallback(providerType, 'Malformed response')
        const models: DiscoveredModel[] = raw.models
            .filter(m => m && typeof m.name === 'string')
            .map(m => ({ id: m.name }))
        return { ok: true, models }
    } catch (err) {
        const message = err instanceof Error
            ? (err.name === 'AbortError' ? 'Discovery timed out' : err.message)
            : 'Discovery failed'
        return fallback(providerType, message.slice(0, 200))
    }
}

/**
 * Discover the live set of chat models a given API key has access to.
 *
 * Returns { ok: true, models } on success, or { ok: false, error, fallbackModels }
 * on every edge (network, 4xx, 5xx, timeout, malformed). Never throws.
 */
export async function discoverModels(
    providerType: string,
    credentials: DiscoverCredentials,
): Promise<DiscoveryResult> {
    const apiKey = credentials.apiKey ?? ''
    const baseUrl = credentials.baseUrl ?? ''

    try {
        switch (providerType) {
            case 'openai':
                return discoverOpenAICompatible('openai', 'https://api.openai.com/v1', apiKey)
            case 'groq':
                return discoverOpenAICompatible('groq', 'https://api.groq.com/openai/v1', apiKey)
            case 'deepseek':
                return discoverOpenAICompatible('deepseek', 'https://api.deepseek.com/v1', apiKey)
            case 'cerebras':
                return discoverOpenAICompatible('cerebras', 'https://api.cerebras.ai/v1', apiKey)
            case 'together':
                return discoverOpenAICompatible('together', 'https://api.together.xyz/v1', apiKey)
            case 'fireworks':
                return discoverOpenAICompatible('fireworks', 'https://api.fireworks.ai/inference/v1', apiKey)
            case 'perplexity':
                return discoverOpenAICompatible('perplexity', 'https://api.perplexity.ai', apiKey)
            case 'openrouter':
                return discoverOpenAICompatible('openrouter', 'https://openrouter.ai/api/v1', apiKey)
            case 'mistral':
                return discoverOpenAICompatible('mistral', 'https://api.mistral.ai/v1', apiKey)
            case 'xai':
                return discoverOpenAICompatible('xai', 'https://api.x.ai/v1', apiKey)
            case 'cohere':
                // Cohere's OpenAI-compatible list endpoint lives under /compatibility/v1.
                return discoverOpenAICompatible('cohere', 'https://api.cohere.ai/compatibility/v1', apiKey)

            case 'anthropic':
                return discoverAnthropic(apiKey)
            case 'google':
                return discoverGoogle(apiKey)

            case 'ollama':
            case 'ollama_cloud':
                return discoverOllama(providerType, baseUrl, apiKey)

            // Static catalog only — no public list endpoint.
            case 'cloudflare':
            case 'voyage':
            case 'sambanova':
                return fallback(providerType, 'No discovery endpoint — using static catalog')

            default:
                if (providerType.startsWith('custom_')) {
                    // Custom OpenAI-compatible providers: probe /v1/models if baseUrl provided.
                    if (!baseUrl) return fallback(providerType, 'Custom provider requires baseUrl')
                    let b = baseUrl.replace(/\/+$/, '')
                    if (!b.endsWith('/v1')) b += '/v1'
                    return discoverOpenAICompatible(providerType, b, apiKey)
                }
                return fallback(providerType, `Unknown provider: ${providerType}`)
        }
    } catch (err) {
        // Absolute safety net — should be unreachable because every branch
        // handles its own errors, but soft-fail just in case.
        logger.warn({ err, providerType }, 'discoverModels unexpected error')
        const message = err instanceof Error ? err.message : 'Unknown discovery error'
        return fallback(providerType, message.slice(0, 200))
    }
}

export { STATIC_ONLY_PROVIDERS }
