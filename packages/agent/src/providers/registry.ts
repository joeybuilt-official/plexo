// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import { buildSubscriptionFetch, resolveSubscriptionToken } from './subscription-fetch'
import { db, eq, sql } from '@plexo/db'
import { modelsKnowledge } from '@plexo/db'
import { openai, createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createMistral } from '@ai-sdk/mistral'
import { createGroq } from '@ai-sdk/groq'
import { createXai } from '@ai-sdk/xai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createHash } from 'crypto'

// Per-call undici Agent for Anthropic. The process-wide global Pool can
// accumulate stuck sockets under load (cron loops failing against unreachable
// endpoints), so each Anthropic call gets a fresh dispatcher to avoid
// inheriting that corruption.
//
// Lazy-imported because undici may be a vendored bind-mount that doesn't
// resolve at static-import time in test environments.
type UndiciAgentCtor = new (opts: Record<string, unknown>) => unknown
let cachedUndiciAgent: UndiciAgentCtor | null = null
let undiciLoadAttempted = false
async function loadUndiciAgent(): Promise<UndiciAgentCtor | null> {
    if (cachedUndiciAgent) return cachedUndiciAgent
    if (undiciLoadAttempted) return null
    undiciLoadAttempted = true
    try {
        const mod = await import('undici')
        cachedUndiciAgent = (mod as { Agent: UndiciAgentCtor }).Agent
        return cachedUndiciAgent
    } catch {
        return null
    }
}

function buildAnthropicFetch(): typeof globalThis.fetch {
    return (async (url: any, init: any) => {
        const Agent = await loadUndiciAgent()
        if (!Agent) return globalThis.fetch(url, init)
        const dispatcher = new Agent({
            connectTimeout: 60_000,
            headersTimeout: 120_000,
            bodyTimeout: 120_000,
            pipelining: 0,
            keepAliveTimeout: 1,
            keepAliveMaxTimeout: 1,
        })
        return globalThis.fetch(url, { ...(init ?? {}), dispatcher } as any)
    }) as unknown as typeof globalThis.fetch
}

/**
 * DeepSeek-latency fix: createDeepSeek() (and other Vercel AI SDK provider
 * factories) each instantiate a fresh fetch client and HTTP agent. Calling
 * it on every request prevents Node's native keep-alive / connection-pool
 * reuse, which is what was making DeepSeek calls feel slow even when the
 * provider itself was healthy.
 *
 * We cache provider instances keyed by (providerKey, apiKey-hash) for the
 * lifetime of the process. The map is bounded so a stream of unique keys
 * (e.g. credential rotations) never grows unboundedly.
 */
const PROVIDER_CACHE_MAX = 64
const providerCache = new Map<string, unknown>()

function providerCacheKey(providerKey: string, apiKey: string | undefined): string {
    const hashed = apiKey
        ? createHash('sha1').update(apiKey).digest('hex').slice(0, 16)
        : 'env'
    return `${providerKey}:${hashed}`
}

function getCachedProvider<T>(providerKey: string, apiKey: string | undefined, build: () => T): T {
    const key = providerCacheKey(providerKey, apiKey)
    const hit = providerCache.get(key) as T | undefined
    if (hit) return hit
    const built = build()
    if (providerCache.size >= PROVIDER_CACHE_MAX) {
        // Drop oldest key (Map preserves insertion order)
        const firstKey = providerCache.keys().next().value
        if (firstKey !== undefined) providerCache.delete(firstKey)
    }
    providerCache.set(key, built)
    return built
}

/** Drop a single cached provider — call after credential rotation/revocation. */
export function clearProviderCache(providerKey?: string): void {
    if (!providerKey) {
        providerCache.clear()
        return
    }
    for (const k of Array.from(providerCache.keys())) {
        if (k.startsWith(`${providerKey}:`)) providerCache.delete(k)
    }
}
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
// Ollama uses OpenAI-compatible endpoint (ollama-ai-provider is V1 only)

/**
 * Rewrite localhost/127.0.0.1 URLs to the Docker host gateway when running
 * inside a container. This allows borrowed Ollama configs (pointing to the
 * user's host machine) to work from Dockerized Plexo without manual config.
 *
 * Detection: /.dockerenv exists, or PLEXO_DOCKER=1 is set.
 */
import { existsSync } from 'fs'
const IS_DOCKER = process.env.PLEXO_DOCKER === '1' || existsSync('/.dockerenv')

// Docker host gateway resolution:
// 1. Explicit env var override (OLLAMA_DOCKER_HOST)
// 2. host.docker.internal (works on Docker Desktop for Mac/Windows and modern Linux Docker 20.10+)
// 3. 172.17.0.1 (Linux Docker bridge gateway — fallback for older Docker)
function detectDockerHost(): string {
    if (process.env.OLLAMA_DOCKER_HOST) return process.env.OLLAMA_DOCKER_HOST
    // On Linux, check if host.docker.internal resolves; fall back to bridge gateway
    if (process.platform === 'linux') {
        try {
            const { execSync } = require('child_process')
            execSync('getent hosts host.docker.internal', { stdio: 'ignore', timeout: 1000 })
            return 'host.docker.internal'
        } catch {
            return '172.17.0.1'
        }
    }
    return 'host.docker.internal'
}
const DOCKER_HOST = IS_DOCKER ? detectDockerHost() : 'host.docker.internal'

export function resolveBaseUrl(url: string): string {
    if (!IS_DOCKER) return url
    const resolved = url
        .replace(/\/\/localhost([:\/])/g, `//${DOCKER_HOST}$1`)
        .replace(/\/\/127\.0\.0\.1([:\/])/g, `//${DOCKER_HOST}$1`)
    if (resolved !== url) {
        console.log(`[ollama] Rewrote ${url} → ${resolved} (Docker host: ${DOCKER_HOST})`)
    }
    return resolved
}

/**
 * Resilient fetch wrapper for Ollama Cloud.
 *
 * Ollama Cloud hosts reasoning models (kimi-k2.6, deepseek-r1, etc.) that
 * return their entire answer in a non-standard `reasoning` field while
 * leaving OpenAI's `content` empty. The AI SDK's openai-compatible provider
 * sees empty content and returns an empty string to callers, which then
 * trips Plexo's empty-response retry path even though the model did
 * produce output. This wrapper rewrites the response so `content` picks
 * up `reasoning` when `content` is empty, preserving the reasoning content
 * for downstream consumption.
 */
function ollamaCloudResilientFetch(): typeof globalThis.fetch {
    return async (input, init) => {
        const resp = await globalThis.fetch(input, init)
        if (!resp.ok) return resp
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (!url.includes('/chat/completions')) return resp
        // Only rewrite non-streamed JSON responses. Streaming (SSE) is passed
        // through unchanged — reasoning deltas are already interleaved there.
        const contentType = resp.headers.get('content-type') ?? ''
        if (!contentType.includes('application/json')) return resp

        type OCResponse = {
            choices?: Array<{
                message?: { role?: string; content?: string | null; reasoning?: string | null }
                finish_reason?: string
            }>
        }
        let data: OCResponse
        try {
            data = (await resp.clone().json()) as OCResponse
        } catch {
            return resp
        }

        let mutated = false
        for (const choice of data.choices ?? []) {
            const msg = choice.message
            if (!msg) continue
            const content = (msg.content ?? '').trim()
            const reasoning = (msg.reasoning ?? '').trim()
            if (!content && reasoning) {
                msg.content = reasoning
                mutated = true
            }
        }
        if (!mutated) return resp

        return new Response(JSON.stringify(data), {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
        })
    }
}

/**
 * Canonical list of supported built-in provider keys.
 * This is the single source of truth — every UI catalog, save route,
 * and adapter switch must accept exactly these keys (plus `custom_*`
 * and the `voyage` embeddings-only provider). Adding a provider means
 * adding it here AND adding cases to `buildModel` and `buildTestModel`.
 */
export const BUILTIN_PROVIDER_KEYS = [
    'openrouter',
    'anthropic',
    'anthropic_subscription',
    'openai',
    'google',
    'mistral',
    'groq',
    'xai',
    'deepseek',
    'together',
    'fireworks',
    'perplexity',
    'cerebras',
    'sambanova',
    'cohere',
    'cloudflare',
    'ollama',
    'ollama_cloud',
    'fal',
] as const

export type BuiltinProviderKey = typeof BUILTIN_PROVIDER_KEYS[number]

const BUILTIN_PROVIDER_KEY_SET: ReadonlySet<string> = new Set(BUILTIN_PROVIDER_KEYS)

/** Embeddings-only providers that are not used for chat. */
export const EMBEDDINGS_ONLY_PROVIDER_KEYS = ['voyage'] as const

/**
 * Check whether a provider key is a recognized builtin. Custom providers
 * (prefixed `custom_`) and embeddings-only providers (e.g. `voyage`) are
 * accepted separately — this guard is for chat providers only.
 */
export function isBuiltinProviderKey(key: string): key is BuiltinProviderKey {
    return BUILTIN_PROVIDER_KEY_SET.has(key)
}

/** Whether a provider key is acceptable anywhere in the system (chat + embeddings + custom). */
export function isKnownProviderKey(key: string): boolean {
    if (isBuiltinProviderKey(key)) return true
    if (key.startsWith('custom_')) return true
    if ((EMBEDDINGS_ONLY_PROVIDER_KEYS as readonly string[]).includes(key)) return true
    return false
}

export type ProviderKey = BuiltinProviderKey | `custom_${string}`

export type TaskType =
    | 'planning'
    | 'codeGeneration'
    | 'verification'
    | 'summarization'
    | 'conversation'
    | 'classification'
    | 'logAnalysis'
    | 'extraction'
    | 'judging'

/**
 * Default model IDs per task type.
 * These are the fallback when no workspace-level override is set.
 * NEVER make these runtime-configurable — they are defaults, not enforced limits.
 */
export const DEFAULT_MODEL_ROUTING: Record<TaskType, string> = {
    planning: 'claude-sonnet-4-5',
    codeGeneration: 'claude-sonnet-4-5',
    verification: 'claude-sonnet-4-5',
    summarization: 'claude-haiku-4-5',
    conversation: 'claude-haiku-4-5',
    classification: 'claude-haiku-4-5',
    logAnalysis: 'claude-haiku-4-5',
    extraction: 'claude-sonnet-4-5',
    judging: 'claude-sonnet-4-5',
}

export interface AIProviderConfig {
    provider: ProviderKey
    apiKey?: string
    baseUrl?: string        // for Ollama or custom OpenAI-compatible endpoints
    model?: string          // provider-level default model override
    customFetch?: typeof globalThis.fetch // For proxy/security injections
    /** User-level enable/disable toggle; false overrides all other checks */
    enabled?: boolean
    /** For custom providers: human-readable name shown in the UI */
    displayName?: string
    /** SDK factory selection for custom providers */
    compatMode?: 'openai' | 'anthropic' | 'ollama'
}

export interface WorkspaceAISettings {
    primaryProvider: ProviderKey
    fallbackChain: ProviderKey[]   // ordered; tried if primary fails
    providers: Partial<Record<ProviderKey, AIProviderConfig>>
    modelOverrides?: Partial<Record<TaskType, string>>
    /** Configuration for IntelligentRouter */
    inferenceMode?: 'auto' | 'byok' | 'proxy' | 'override'
    /** Max judges recruited from Ollama ensemble (1–5). Default 3. */
    ensembleSize?: number
    /** Score deviation from mean that triggers cloud arbitration (0–1). Default 0.25. */
    dissentThreshold?: number
    /**
     * Optional dedicated model for the quality judge — pinned because most
     * primary models (e.g. llama-3.3-70b) can't reliably emit JSON-schema
     * output, which causes the judge's structured-output call to fail and
     * fall through to a self-score passthrough. Set this to a JSON-reliable
     * model (Anthropic Claude, OpenAI gpt-4o-mini) to restore judge function
     * without changing the execution primary.
     *
     * Stored in `workspaces.intelligence_settings.judgeModel`.
     */
    judgeModel?: { provider: ProviderKey; model: string }
}

// Use a broad type that works with generateText — all providers return LanguageModelV2 or V3
// which are both accepted by generateText / generateObject in ai@6
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyLanguageModel = any

/**
 * Build a LanguageModel instance for a given provider + task type.
 *
 * Model ID resolution order:
 *   1. settings.modelOverrides[taskType]          — explicit per-task workspace override
 *   2. config.model                               — provider-level selected model (from UI)
 *   3. PROVIDER_DEFAULT_MODELS[providerKey]       — provider-appropriate fallback
 *   4. DEFAULT_MODEL_ROUTING[taskType]            — last resort (may be wrong provider family)
 *
 * API key resolution: always uses config.apiKey when present, never assumes env vars
 * are set — keys are stored in the workspace DB and must flow through config.
 */

/** Per-provider sensible default models — used when no model is explicitly selected. */
export const PROVIDER_DEFAULT_MODELS: Partial<Record<string, string>> = {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-6',
    anthropic_subscription: 'claude-sonnet-4-5',
    google: 'gemini-2.5-flash',
    mistral: 'mistral-large-latest',
    groq: 'llama-3.3-70b-versatile',
    xai: 'grok-3-mini',
    deepseek: 'deepseek-chat',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    perplexity: 'sonar',
    cerebras: 'llama3.1-8b',
    sambanova: 'Meta-Llama-3.3-70B-Instruct',
    cohere: 'command-a-03-2025',
    cloudflare: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    ollama: 'llama3.2',
    ollama_cloud: 'gpt-oss:20b-cloud',
    // Free tier default — works with any key, no credits required.
    // deepseek-chat-v3-0324:free is generally available regardless of OR privacy settings.
    openrouter: 'deepseek/deepseek-chat-v3-0324:free',
    // fal.ai: image/video generation platform — no chat models.
    // Default is their fastest image gen model.
    fal: 'fal-ai/flux/schnell',
}

export function buildModel(
    providerKey: ProviderKey,
    config: AIProviderConfig,
    taskType: TaskType,
    settings: WorkspaceAISettings,
    /**
     * Per-call forced model id (Round-4 D2). When set + valid it wins over the
     * workspace cascade — used by the router when the selector force-picks a
     * model for a specific caller (e.g. background graphiti → a fast model).
     * Highest precedence so it overrides even settings.modelOverrides[taskType].
     */
    modelIdOverride?: string,
): AnyLanguageModel {
    // Resolve model ID — never let a Claude ID land on a non-Anthropic provider
    const validModel = (id: string | undefined) =>
        id && id.trim() !== '' && id !== 'default' && id !== 'placeholder' ? id : undefined

    let modelId =
        validModel(modelIdOverride) ??
        validModel(settings.modelOverrides?.[taskType]) ??
        validModel(config.model) ??
        PROVIDER_DEFAULT_MODELS[providerKey] ??
        DEFAULT_MODEL_ROUTING[taskType]

    // Reasoning models (e.g. deepseek-reasoner) burn 15-90s of hidden
    // chain-of-thought tokens before producing output. They are NEVER the
    // right pick for fast or tool-using paths and are only opt-in for the
    // narrow set of task types where the extra reasoning genuinely helps.
    //
    // Phase 0 of the intelligence overhaul (commit follows) tightens this
    // matrix so reasoner can never accidentally land on chat, classification,
    // codeGeneration, verification, or logAnalysis — all of which got
    // reasoner before because nothing in the cascade prevented it.
    //
    // Workspaces that genuinely want reasoner for codeGeneration must opt in
    // explicitly via Phase 2b's per-task-type chain editor (slot 0078,
    // routing_chains table) — that path bypasses this swap.
    const REASONER_OPT_IN_TIERS: Set<string> = new Set([
        'planning',  // multi-step plan generation legitimately benefits from CoT
    ])

    // Every other tier auto-swaps reasoner → deepseek-chat. The set is
    // exhaustive against the TaskType union so future tiers fail safely.
    const REASONER_NEVER_TIERS: Set<string> = new Set([
        'conversation',
        'classification',
        'summarization',
        'codeGeneration',
        'verification',
        'logAnalysis',
        'extraction',
    ])

    if (modelId === 'deepseek-reasoner') {
        if (REASONER_NEVER_TIERS.has(taskType)) {
            modelId = 'deepseek-chat'
        } else if (!REASONER_OPT_IN_TIERS.has(taskType)) {
            // Defensive default for any new task type added in the future:
            // swap to chat unless explicitly opted in.
            modelId = 'deepseek-chat'
        }
    }

    switch (providerKey) {
        case 'openrouter': {
            const or = createOpenRouter({ apiKey: config.apiKey!, fetch: config.customFetch })
            return or(modelId)
        }
        case 'anthropic': {
            const provider = config.apiKey
                ? createAnthropic({ apiKey: config.apiKey, fetch: buildAnthropicFetch() as any })
                : anthropic
            return provider(modelId)
        }
        case 'anthropic_subscription': {
            // Claude Max subscription via OAuth token. Coexists with the
            // API-key `anthropic` path above and never replaces it. The token
            // is sourced from config/env, never logged, and is applied only in
            // the subscription fetch wrapper.
            const token = resolveSubscriptionToken(config.apiKey)
            const provider = getCachedProvider('anthropic_subscription', token, () =>
                createAnthropic({ apiKey: token, fetch: buildSubscriptionFetch(token) as any }),
            )
            return provider(modelId)
        }
        case 'openai': {
            const oa = config.apiKey
                ? createOpenAI({ apiKey: config.apiKey })
                : openai
            return (oa as typeof openai)(modelId)
        }
        case 'google': {
            const goog = config.apiKey
                ? createGoogleGenerativeAI({ apiKey: config.apiKey })
                : createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '' })
            return goog(modelId)
        }
        case 'mistral': {
            const mi = config.apiKey
                ? createMistral({ apiKey: config.apiKey })
                : createMistral({ apiKey: process.env.MISTRAL_API_KEY ?? '' })
            return mi(modelId)
        }
        case 'groq': {
            const gr = config.apiKey
                ? createGroq({ apiKey: config.apiKey })
                : createGroq({ apiKey: process.env.GROQ_API_KEY ?? '' })
            return gr(modelId)
        }
        case 'xai': {
            const xa = config.apiKey
                ? createXai({ apiKey: config.apiKey })
                : createXai({ apiKey: process.env.XAI_API_KEY ?? '' })
            return xa(modelId)
        }
        case 'deepseek': {
            // Cache the provider factory across requests so the underlying
            // fetch keep-alive pool is reused. See providerCache notes above.
            const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? ''
            const ds = getCachedProvider(
                'deepseek',
                apiKey,
                () => createDeepSeek({ apiKey }),
            ) as ReturnType<typeof createDeepSeek>
            return ds(modelId)
        }
        case 'together': {
            const tg = createOpenAICompatible({
                name: 'together',
                baseURL: 'https://api.together.xyz/v1',
                headers: { Authorization: `Bearer ${config.apiKey ?? ''}` },
            })
            return tg(modelId)
        }
        case 'fireworks': {
            const fw = createOpenAICompatible({
                name: 'fireworks',
                baseURL: 'https://api.fireworks.ai/inference/v1',
                headers: { Authorization: `Bearer ${config.apiKey ?? ''}` },
            })
            return fw(modelId)
        }
        case 'perplexity': {
            const pp = createOpenAICompatible({
                name: 'perplexity',
                baseURL: 'https://api.perplexity.ai',
                headers: { Authorization: `Bearer ${config.apiKey ?? ''}` },
            })
            return pp(modelId)
        }
        case 'cerebras': {
            const cb = createOpenAICompatible({
                name: 'cerebras',
                baseURL: 'https://api.cerebras.ai/v1',
                headers: { Authorization: `Bearer ${config.apiKey ?? ''}` },
            })
            return cb(modelId)
        }
        case 'sambanova': {
            const sn = createOpenAICompatible({
                name: 'sambanova',
                baseURL: 'https://api.sambanova.ai/v1',
                headers: { Authorization: `Bearer ${config.apiKey ?? ''}` },
            })
            return sn(modelId)
        }
        case 'cohere': {
            // Cohere's OpenAI-compatible endpoint lives at /compatibility/v1
            // (NOT /v2 — that uses Cohere's native schema, not OpenAI's).
            const co = createOpenAICompatible({
                name: 'cohere',
                baseURL: 'https://api.cohere.ai/compatibility/v1',
                headers: { Authorization: `Bearer ${config.apiKey ?? ''}` },
            })
            return co(modelId)
        }
        case 'cloudflare': {
            const acctId = config.baseUrl ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
            const cf = createOpenAICompatible({
                name: 'cloudflare',
                baseURL: `https://api.cloudflare.com/client/v4/accounts/${acctId}/ai/v1`,
                headers: { Authorization: `Bearer ${config.apiKey ?? ''}` },
            })
            return cf(modelId)
        }
        case 'ollama': {
            let base = resolveBaseUrl((config.baseUrl ?? process.env.OLLAMA_INTERNAL_URL ?? 'http://localhost:11434').replace(/\/+$/, ''))
            // Auto-upgrade http→https for remote Ollama instances behind reverse proxies.
            // Without this, the 301 redirect changes POST to GET, causing 405 errors.
            if (base.startsWith('http://') && !base.includes('localhost') && !base.includes('127.0.0.1')) {
                base = base.replace('http://', 'https://')
            }
            const ol = createOpenAICompatible({
                name: 'ollama',
                baseURL: base + '/v1',
            })
            return ol(modelId)
        }
        case 'ollama_cloud': {
            const oc = createOpenAICompatible({
                name: 'ollama_cloud',
                baseURL: 'https://ollama.com/v1',
                headers: {
                    Authorization: `Bearer ${config.apiKey ?? ''}`,
                },
                fetch: ollamaCloudResilientFetch(),
                supportsStructuredOutputs: true,
            })
            return oc(modelId)
        }
        case 'fal': {
            // fal.ai is an image/video generation platform — it does NOT expose
            // OpenAI-compatible chat completions. Chat routing should never land
            // here (discovery marks supportsChat=false). If it does, fail loudly
            // so the fallback chain moves to the next provider.
            throw new Error(
                'fal.ai does not support chat completions. It is an image/video generation provider. ' +
                'Use it through the media generation pipeline, not the chat router.',
            )
        }
        default: {
            if (!providerKey.startsWith('custom_')) {
                throw new Error(`Unknown provider: ${providerKey}`)
            }
            let base = (config.baseUrl ?? '').replace(/\/+$/, '')
            if (!base) throw new Error(`Custom provider ${providerKey} requires a baseUrl`)
            if (base.startsWith('http://') && !base.includes('localhost') && !base.includes('127.0.0.1')) {
                base = base.replace('http://', 'https://')
            }
            if (!base.endsWith('/v1')) base += '/v1'
            const custom = createOpenAICompatible({
                name: config.displayName ?? providerKey,
                baseURL: base,
                headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
            })
            return custom(modelId)
        }
    }
}

import { IntelligentRouter, VaultConfig, RouterConfig } from './router.js'

/**
 * Resolve the optimal model for a task type from workspace settings using 4-mode arbitration.
 * Returns both the model instance and its resolved metadata for attribution/cost tracking.
 */
export async function resolveModel(
    taskType: TaskType,
    settings: WorkspaceAISettings,
    workspaceId?: string,
): Promise<{ model: AnyLanguageModel; meta: import('./router.js').ResolvedModelMeta }> {
    
    // Deconstruct WorkspaceAISettings into Vault and Config structures
    const vault: VaultConfig = {}
    const routerProviders: RouterConfig['providers'] = {}

    for (const [key, p] of Object.entries(settings.providers)) {
        if (!p) continue
        vault[key] = {
            apiKey: p.apiKey,
            baseUrl: p.baseUrl
        }
        routerProviders[key] = {
            selectedModel: p.model,
            // Respect the user-level enable/disable toggle from arbiter; fall back to key/url existence only when field is absent
            enabled: p.enabled !== undefined ? p.enabled : (p.apiKey !== undefined || p.baseUrl !== undefined),
        }
    }

    const routerConfig: RouterConfig = {
        inferenceMode: settings.inferenceMode ?? 'byok',
        primaryProvider: settings.primaryProvider,
        fallbackChain: settings.fallbackChain,
        providers: routerProviders,
        modelOverrides: settings.modelOverrides
    }

    const router = new IntelligentRouter(vault, routerConfig, workspaceId)
    const { model, meta } = await router.route(taskType)
    
    // Analytics trace: clearly surface the selected model and reasoning
    console.info(JSON.stringify({
        event: 'router.arbitration.resolved',
        taskType,
        mode: meta.mode,
        provider: meta.provider,
        modelId: meta.id,
        costBounds: { in: meta.costPerMIn, out: meta.costPerMOut }
    }))
    
    return { model, meta }
}

/**
 * Resolve a model from environment variables — for internal code paths
 * (sprint planner, memory modules) that run without a user session / workspace settings.
 *
 * Priority: OPENAI_API_KEY → GEMINI/GOOGLE_GENERATIVE_AI_API_KEY → OPENROUTER_API_KEY → GROQ_API_KEY.
 *
 * Throws ProviderResolutionError when no provider env is configured. Earlier
 * versions fell back to a local Ollama at OLLAMA_INTERNAL_URL (default
 * http://ollama:11434) "as a last resort"; in this deployment the host does
 * not exist, so the silent fallback masked the real failure as cryptic
 * `getaddrinfo ENOTFOUND ollama` errors deep in the call chain. Callers must
 * either provide workspace AI settings (preferred path) or configure one of
 * the env vars above.
 *
 * @param modelId  Optional explicit model ID override.
 *                 When omitted the DEFAULT_MODEL_ROUTING for the task type is used.
 */
export function resolveModelFromEnv(modelId?: string): AnyLanguageModel {
    const id = modelId ?? DEFAULT_MODEL_ROUTING.summarization

    if (process.env.OPENAI_API_KEY) {
        const openaiId = id.startsWith('claude') ? 'gpt-4o-mini' : id
        return openai(openaiId)
    }
    const geminiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY
    if (geminiKey) {
        const goog = createGoogleGenerativeAI({ apiKey: geminiKey })
        return goog('gemini-2.5-flash')
    }
    if (process.env.OPENROUTER_API_KEY) {
        const or = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
        return or(id)
    }
    if (process.env.GROQ_API_KEY) {
        const gr = createGroq({ apiKey: process.env.GROQ_API_KEY })
        return gr('llama-3.3-70b-versatile')
    }
    throw new ProviderResolutionError(
        'No LLM provider available: workspace AI settings not loaded for this request and no system-wide provider env var is configured (OPENAI_API_KEY, GEMINI/GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY).'
    )
}

export class ProviderResolutionError extends Error {
    readonly code = 'NO_PROVIDER_AVAILABLE'
    constructor(message: string) {
        super(message)
        this.name = 'ProviderResolutionError'
    }
}

/**
 * Direct Ollama model factory — bypasses the workspace router. Used by
 * service-key endpoints that target the local Ollama install
 * (OLLAMA_INTERNAL_URL) for a specific multimodal model rather than the
 * workspace's configured provider cascade.
 *
 * Returns an AI-SDK language model the caller can pass to `callModel({ model })`.
 *
 * Defaults `baseUrl` from OLLAMA_INTERNAL_URL (matches the `case 'ollama'`
 * branch above), preserving the docker-host rewrite behaviour.
 */
export function buildOllamaModel(
    modelId: string,
    opts?: { baseUrl?: string },
): AnyLanguageModel {
    const base = resolveBaseUrl(
        (opts?.baseUrl ?? process.env.OLLAMA_INTERNAL_URL ?? 'http://localhost:11434').replace(/\/+$/, ''),
    )
    // NOTE: the workspace router's `case 'ollama'` branch auto-upgrades
    // http://→https:// for non-localhost hosts. That's correct for
    // user-configured remote Ollama URLs behind reverse proxies, but
    // WRONG for in-cluster Docker DNS names (e.g. http://ollama:11434).
    // The unified analyze-image endpoint is always called against the
    // platform-owned OLLAMA_INTERNAL_URL — never a user-configured remote —
    // so we skip the upgrade here. If a future caller needs the upgrade,
    // they should rewrite the env var.
    const ol = createOpenAICompatible({
        name: 'ollama',
        baseURL: base + '/v1',
    })
    return ol(modelId)
}



// Stale-key and circuit-breaker state used to live here, attached to the
// legacy `withFallback` chain walk. Router-v2 replaced that with
// `auth-events.ts` (consecutive-failure tracking + telemetry) and
// per-class cooldown in `router-v2/index.ts`. The exports below remain
// as no-op stubs so external callers (ai-provider-creds, tests) keep
// compiling; future PR can wire ai-provider-creds to
// `auth-events.recordAuthSuccess` when a user updates an API key.

/** @deprecated since router-v2 cutover (L3.4j 2026-05-23). No-op. */
export function clearStaleKey(_workspaceId: string, _providerKey: string): void {
    /* no-op — router-v2/auth-events tracks failures now */
}

/** @deprecated since router-v2 cutover (L3.4j 2026-05-23). No-op. */
export function clearProviderBreaker(_providerKey: string): void {
    /* no-op — router-v2 cooldown is per-(workspace, provider, model, taskType), self-expiring */
}

/** @deprecated since router-v2 cutover (L3.4j 2026-05-23). No-op. Use `router-v2/auth-events._resetForTest()` instead. */
export function _resetProviderBreakerForTest(): void {
    /* no-op */
}

export interface FallbackOptions {
    /** Workspace ID — enables stale-key tracking and auto-skip. */
    workspaceId?: string
    /** Called when a provider is skipped or fails due to auth errors. */
    onAuthFailure?: (providerKey: string, error: string) => void
    /**
     * Called once when a non-primary provider successfully serves a request.
     * Use this to surface "we had to fall back" to the operator (logs, telegram,
     * UI toast). Fires only on success — failures are noisy and would spam.
     */
    onFallbackEngaged?: (info: { workspaceId?: string; taskType: TaskType; primary: string; used: string; skipped: string[]; lastError: string }) => void
}

// withFallback() retired 2026-05-23 (L3.4j). All callers now use
// routeAndCall() from './router-v2/index.js' directly. Error classification
// + cooldown logic moved into 'router-v2/error-classifier.ts' (classes:
// rate-limit, transient-5xx, network, auth, quota, context-window,
// content-policy, parse-malformed).

// ── Default smoke-test model IDs per provider ─────────────────────────────────

// Smoke-test models for connection validation.
// Rule: pick the smallest, cheapest, most widely-accessible chat model per
// provider. The test only validates that the API key works — model quality
// is irrelevant. Never use reasoning models (too slow, token-hungry) and
// never use gated/paid-tier models that the free tier can't access.
const DEFAULT_TEST_MODELS: Partial<Record<string, string>> = {
    // Must use :free suffix — OpenRouter 402s on accounts with no purchase history
    // when a paid endpoint is requested. Candidates are tried in order (waterfall).
    // Some fail if user has "Model Training" disabled in OR privacy settings.
    openrouter: 'deepseek/deepseek-chat-v3-0324:free',
    anthropic: 'claude-haiku-4-5',
    anthropic_subscription: 'claude-haiku-4-5',
    openai: 'gpt-4o-mini',
    google: 'gemini-2.5-flash',
    mistral: 'mistral-small-latest',
    // Groq: 8b-instant is the smallest + fastest, definitely in free tier.
    // Previous llama-3.3-70b-versatile can 403 on restricted free keys.
    groq: 'llama-3.1-8b-instant',
    xai: 'grok-3-mini',
    deepseek: 'deepseek-chat',
    // Together: 8B Turbo is the smallest serverless chat model available to
    // every key. Avoid 70B — free starter keys lack access.
    together: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    // Fireworks: only 70b Instruct is confirmed deployed and available via OpenAI-compat
    // endpoint across all accounts. Smaller 8B/3B variants are not deployed.
    fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    perplexity: 'sonar',
    // Cerebras: 8B is the ONLY model guaranteed in the free tier. Larger
    // models (qwen-3-235b, gpt-oss-120b, zai-glm-4.7) require paid access
    // and return 403 "API key doesn't have permission for this model".
    cerebras: 'llama3.1-8b',
    // SambaNova: 8B variant is in the free tier; 70B is paid.
    sambanova: 'Meta-Llama-3.1-8B-Instruct',
    // Cohere: command-r is the cheapest chat model.
    cohere: 'command-r',
    // Cloudflare: 8B instruct is the smallest chat model on Workers AI.
    cloudflare: '@cf/meta/llama-3.1-8b-instruct',
    ollama: 'llama3.2',
    ollama_cloud: 'gpt-oss:20b-cloud',
    // fal.ai: not a chat provider — smoke test validates the API key via
    // a lightweight GET to their status endpoint, not a model call.
    fal: 'fal-ai/flux/schnell',
}

const PROVIDER_ENV_KEY: Partial<Record<string, string>> = {
    openrouter: 'OPENROUTER_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    groq: 'GROQ_API_KEY',
    xai: 'XAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    fal: 'FAL_KEY',
}

function buildTestModel(providerKey: ProviderKey, modelId: string, baseUrl?: string, apiKey?: string): AnyLanguageModel {
    switch (providerKey) {
        case 'openrouter': {
            if (!apiKey) throw new Error('OpenRouter requires an API key')
            return createOpenRouter({ apiKey })(modelId)
        }
        case 'anthropic': {
            const provider = apiKey
                ? createAnthropic({ apiKey })
                : anthropic
            return provider(modelId)
        }
        case 'anthropic_subscription': {
            const token = resolveSubscriptionToken(apiKey)
            return getCachedProvider('anthropic_subscription', token, () =>
                createAnthropic({ apiKey: token, fetch: buildSubscriptionFetch(token) as any }),
            )(modelId)
        }
        case 'openai': {
            const oa = apiKey ? createOpenAI({ apiKey }) : openai
            return (oa as typeof openai)(modelId)
        }
        case 'google': {
            const goog = apiKey
                ? createGoogleGenerativeAI({ apiKey })
                : createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '' })
            return goog(modelId)
        }
        case 'mistral': {
            const mi = apiKey
                ? createMistral({ apiKey })
                : createMistral({ apiKey: process.env.MISTRAL_API_KEY ?? '' })
            return mi(modelId)
        }
        case 'groq': {
            const gr = apiKey
                ? createGroq({ apiKey })
                : createGroq({ apiKey: process.env.GROQ_API_KEY ?? '' })
            return gr(modelId)
        }
        case 'xai': {
            const xa = apiKey
                ? createXai({ apiKey })
                : createXai({ apiKey: process.env.XAI_API_KEY ?? '' })
            return xa(modelId)
        }
        case 'deepseek': {
            const k = apiKey ?? process.env.DEEPSEEK_API_KEY ?? ''
            const ds = getCachedProvider(
                'deepseek',
                k,
                () => createDeepSeek({ apiKey: k }),
            ) as ReturnType<typeof createDeepSeek>
            return ds(modelId)
        }
        case 'together': {
            return createOpenAICompatible({
                name: 'together',
                baseURL: 'https://api.together.xyz/v1',
                headers: { Authorization: `Bearer ${apiKey ?? ''}` },
            })(modelId)
        }
        case 'fireworks': {
            return createOpenAICompatible({
                name: 'fireworks',
                baseURL: 'https://api.fireworks.ai/inference/v1',
                headers: { Authorization: `Bearer ${apiKey ?? ''}` },
            })(modelId)
        }
        case 'perplexity': {
            return createOpenAICompatible({
                name: 'perplexity',
                baseURL: 'https://api.perplexity.ai',
                headers: { Authorization: `Bearer ${apiKey ?? ''}` },
            })(modelId)
        }
        case 'cerebras': {
            return createOpenAICompatible({
                name: 'cerebras',
                baseURL: 'https://api.cerebras.ai/v1',
                headers: { Authorization: `Bearer ${apiKey ?? ''}` },
            })(modelId)
        }
        case 'sambanova': {
            return createOpenAICompatible({
                name: 'sambanova',
                baseURL: 'https://api.sambanova.ai/v1',
                headers: { Authorization: `Bearer ${apiKey ?? ''}` },
            })(modelId)
        }
        case 'cohere': {
            return createOpenAICompatible({
                name: 'cohere',
                baseURL: 'https://api.cohere.ai/compatibility/v1',
                headers: { Authorization: `Bearer ${apiKey ?? ''}` },
            })(modelId)
        }
        case 'cloudflare': {
            // baseUrl param carries the Cloudflare account ID for cloud providers
            // (the Intelligence UI doesn't have a dedicated account-id field yet,
            // so the user places it in the endpoint URL field).
            const acctId = baseUrl ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
            return createOpenAICompatible({
                name: 'cloudflare',
                baseURL: `https://api.cloudflare.com/client/v4/accounts/${acctId}/ai/v1`,
                headers: { Authorization: `Bearer ${apiKey ?? ''}` },
            })(modelId)
        }
        case 'ollama': {
            const base = resolveBaseUrl((process.env.OLLAMA_INTERNAL_URL ?? baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '')) + '/v1'
            return createOpenAICompatible({ name: 'ollama', baseURL: base })(modelId)
        }
        case 'ollama_cloud': {
            return createOpenAICompatible({
                name: 'ollama_cloud',
                baseURL: 'https://ollama.com/v1',
                headers: { Authorization: `Bearer ${apiKey ?? ''}` },
                fetch: ollamaCloudResilientFetch(),
                supportsStructuredOutputs: true,
            })(modelId)
        }
        case 'fal': {
            // fal.ai has no chat completions endpoint — buildTestModel is only
            // used by testProvider, which has a dedicated fal branch that
            // validates the key via REST. This case should never be reached.
            throw new Error('fal.ai does not support OpenAI-compatible chat. Use testProvider() directly.')
        }
        default: {
            if (!providerKey.startsWith('custom_')) {
                throw new Error(`Unknown provider: ${providerKey}`)
            }
            let base = (baseUrl ?? '').replace(/\/+$/, '')
            if (!base) throw new Error(`Custom provider ${providerKey} requires a baseUrl`)
            if (base.startsWith('http://') && !base.includes('localhost') && !base.includes('127.0.0.1')) {
                base = base.replace('http://', 'https://')
            }
            if (!base.endsWith('/v1')) base += '/v1'
            return createOpenAICompatible({
                name: providerKey,
                baseURL: base,
                headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            })(modelId)
        }
    }
}

export interface ProviderTestResult {
    ok: boolean
    message: string
    latencyMs: number
    model: string
}

/**
 * Smoke-test a provider by sending a tiny prompt.
 * If apiKey is provided it is temporarily injected into process.env for the
 * duration of this call only, then immediately restored.
 */
export async function testProvider(
    providerKey: ProviderKey,
    opts: { apiKey?: string; baseUrl?: string; model?: string },
    timeoutMs = 10_000,
): Promise<ProviderTestResult> {
    const { generateText: gt } = await import('ai')
    const start = Date.now()

    // ── fal.ai: validate API key via a lightweight REST call ────────────────
    // fal.ai has no OpenAI-compatible chat endpoint. We validate the key by
    // submitting a minimal request to their fastest model (flux/schnell) and
    // checking whether the API key is accepted (2xx vs 401/403).
    if (providerKey === 'fal') {
        if (!opts.apiKey) {
            return { ok: false, message: 'fal.ai requires an API key. Get one at fal.ai/dashboard/keys.', latencyMs: 0, model: '' }
        }
        try {
            // Hit the queue status endpoint with a dry-run style request.
            // We use the /fal-ai/flux/schnell endpoint — it's fast and cheap.
            // A 401/403 means bad key; 200/422 means key is valid.
            const res = await fetch('https://queue.fal.run/fal-ai/flux/schnell', {
                method: 'POST',
                headers: {
                    Authorization: `Key ${opts.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ prompt: 'test', num_images: 1, image_size: 'square', enable_safety_checker: true }),
                signal: AbortSignal.timeout(timeoutMs),
            })
            if (res.status === 401 || res.status === 403) {
                return { ok: false, message: 'Invalid API key. Check fal.ai/dashboard/keys.', latencyMs: Date.now() - start, model: 'fal-ai/flux/schnell' }
            }
            // Any 2xx or 422 (validation error) means the key is valid
            return { ok: true, message: 'Connected — API key valid (image/video generation provider)', latencyMs: Date.now() - start, model: opts.model ?? 'fal-ai/flux/schnell' }
        } catch (err) {
            const message = err instanceof Error ? err.message.slice(0, 200) : 'Connection failed'
            return { ok: false, message, latencyMs: Date.now() - start, model: opts.model ?? '' }
        }
    }

    // ── Ollama local: discover models via GET, pick one, then test ───────────
    if (providerKey === 'ollama') {
        const baseURL = resolveBaseUrl((process.env.OLLAMA_INTERNAL_URL ?? opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '')) + '/v1'
        try {
            const res = await fetch(`${baseURL}/models`, {
                signal: AbortSignal.timeout(timeoutMs),
            })
            if (!res.ok) {
                return { ok: false, message: `Server returned ${res.status}`, latencyMs: Date.now() - start, model: '' }
            }
            const data = await res.json() as { data?: { id: string }[] }
            const models = data.data ?? []
            if (models.length === 0) {
                return { ok: false, message: 'Connected but no models are pulled on this server', latencyMs: Date.now() - start, model: '' }
            }
            // Prefer the specified model if present, otherwise pick smallest by name heuristic
            const modelId = opts.model
                ?? models.find(m => m.id.includes('mini') || m.id.includes('nano') || m.id.includes('small'))?.id
                ?? models[0]!.id
            try {
                const ol = createOpenAICompatible({ name: 'ollama', baseURL })(modelId)
                const ac = new AbortController()
                const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs - (Date.now() - start), 5000))
                const result = await gt({ model: ol, prompt: 'Say "ok".', maxOutputTokens: 20, abortSignal: ac.signal })
                clearTimeout(timer)
                return { ok: true, message: `Connected — ${models.length} model(s) available`, latencyMs: Date.now() - start, model: modelId }
            } catch {
                // POST blocked or generation failed — but server responded to GET, so it's reachable
                return { ok: true, message: `Reachable — ${models.length} model(s) available (generation test skipped)`, latencyMs: Date.now() - start, model: modelId }
            }
        } catch (err) {
            const message = err instanceof Error ? err.message.slice(0, 200) : 'Connection failed'
            return { ok: false, message, latencyMs: Date.now() - start, model: opts.model ?? '' }
        }
    }

    // ── Ollama Cloud: hit https://ollama.com/api/tags with bearer key ─────────
    if (providerKey === 'ollama_cloud') {
        if (!opts.apiKey) {
            return { ok: false, message: 'Ollama Cloud requires an API key. Get one at ollama.com/settings/keys.', latencyMs: 0, model: '' }
        }
        try {
            // Discover available cloud models first
            const tagsRes = await fetch('https://ollama.com/api/tags', {
                headers: { Authorization: `Bearer ${opts.apiKey}` },
                signal: AbortSignal.timeout(timeoutMs),
            })
            if (!tagsRes.ok) {
                const msg = tagsRes.status === 401 || tagsRes.status === 403
                    ? 'Invalid API key — check ollama.com/settings/keys'
                    : `Server returned ${tagsRes.status}`
                return { ok: false, message: msg, latencyMs: Date.now() - start, model: '' }
            }
            const tagsData = await tagsRes.json() as { models?: { name: string }[] }
            const models = (tagsData.models ?? []).map(m => m.name)
            const modelId = opts.model && models.includes(opts.model)
                ? opts.model
                : models[0] ?? 'gpt-oss:20b-cloud'
            // Attempt a generation via OpenAI-compat endpoint
            try {
                const oc = createOpenAICompatible({
                    name: 'ollama_cloud',
                    baseURL: 'https://ollama.com/v1',
                    headers: { Authorization: `Bearer ${opts.apiKey}` },
                    fetch: ollamaCloudResilientFetch(),
                    supportsStructuredOutputs: true,
                })(modelId)
                const ac = new AbortController()
                const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs - (Date.now() - start), 5000))
                await gt({ model: oc, prompt: 'Say "ok".', maxOutputTokens: 20, abortSignal: ac.signal })
                clearTimeout(timer)
                return { ok: true, message: `Connected — ${models.length} cloud model(s) available`, latencyMs: Date.now() - start, model: modelId }
            } catch {
                // Tags worked but generation failed — still report reachable
                return { ok: true, message: `Reachable — ${models.length} cloud model(s) available (generation test skipped)`, latencyMs: Date.now() - start, model: modelId }
            }
        } catch (err) {
            const message = err instanceof Error ? err.message.slice(0, 200) : 'Connection failed'
            return { ok: false, message, latencyMs: Date.now() - start, model: opts.model ?? '' }
        }
    }

    // ── Custom providers: probe /v1/models, pick first or user-specified ───────
    if (providerKey.startsWith('custom_')) {
        let base = (opts.baseUrl ?? '').replace(/\/+$/, '')
        if (!base) {
            return { ok: false, message: 'Custom provider requires a baseUrl', latencyMs: 0, model: '' }
        }
        if (base.startsWith('http://') && !base.includes('localhost') && !base.includes('127.0.0.1')) {
            base = base.replace('http://', 'https://')
        }
        if (!base.endsWith('/v1')) base += '/v1'
        try {
            const headers: Record<string, string> = {}
            if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`
            const res = await fetch(`${base}/models`, {
                headers,
                signal: AbortSignal.timeout(timeoutMs),
            })
            if (!res.ok) {
                return { ok: false, message: `Server returned ${res.status}`, latencyMs: Date.now() - start, model: '' }
            }
            const data = await res.json() as { data?: { id: string }[] }
            const models = data.data ?? []
            if (models.length === 0) {
                return { ok: false, message: 'Connected but no models found on this server', latencyMs: Date.now() - start, model: '' }
            }
            const modelId = opts.model ?? models[0]!.id
            try {
                const custom = createOpenAICompatible({
                    name: providerKey,
                    baseURL: base,
                    headers,
                })(modelId)
                const ac = new AbortController()
                const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs - (Date.now() - start), 5000))
                const result = await gt({ model: custom, prompt: 'Say "ok".', maxOutputTokens: 20, abortSignal: ac.signal })
                clearTimeout(timer)
                return { ok: true, message: `Connected — ${models.length} model(s) available`, latencyMs: Date.now() - start, model: modelId }
            } catch {
                return { ok: true, message: `Reachable — ${models.length} model(s) available (generation test skipped)`, latencyMs: Date.now() - start, model: modelId }
            }
        } catch (err) {
            const message = err instanceof Error ? err.message.slice(0, 200) : 'Connection failed'
            return { ok: false, message, latencyMs: Date.now() - start, model: opts.model ?? '' }
        }
    }

    // ── Google: waterfall through model candidates until one works ────────────
    // Users may have keys with different model access depending on their project / billing tier.
    const GOOGLE_MODEL_PRIORITY = [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
    ]

    if (providerKey === 'google') {
        const envKey = PROVIDER_ENV_KEY.google
        let savedKey: string | undefined
        if (opts.apiKey && envKey) {
            savedKey = process.env[envKey]
            process.env[envKey] = opts.apiKey
        }
        const candidates = opts.model ? [opts.model, ...GOOGLE_MODEL_PRIORITY.filter(m => m !== opts.model)] : GOOGLE_MODEL_PRIORITY
        const errors: string[] = []
        try {
            for (const candidate of candidates) {
                try {
                    const model = buildTestModel('google', candidate, opts.baseUrl)
                    const ac = new AbortController()
                    const timer = setTimeout(() => ac.abort(), timeoutMs)
                    const result = await gt({ model, prompt: 'Reply with the single word "ok".', maxOutputTokens: 20, abortSignal: ac.signal })
                    clearTimeout(timer)
                    if (result.text.trim().length > 0) {
                        return { ok: true, message: `Connected — using ${candidate}`, latencyMs: Date.now() - start, model: candidate }
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : 'error'
                    const lower = msg.toLowerCase()
                    // Auth errors: fail fast. Google surfaces these as 401/403 or
                    // "API key not valid" / "API_KEY_INVALID".
                    if (
                        lower.includes('401') || lower.includes('403') ||
                        lower.includes('api key not valid') ||
                        lower.includes('api_key_invalid') ||
                        lower.includes('invalid api key') ||
                        lower.includes('unauthorized') ||
                        lower.includes('permission denied')
                    ) {
                        return { ok: false, message: 'Invalid API key. Check aistudio.google.com/app/apikey.', latencyMs: Date.now() - start, model: candidate }
                    }
                    errors.push(`${candidate}: ${msg.slice(0, 120)}`)
                }
            }
            // Show the most informative error. If all failed, use the first one.
            const firstError = errors[0] ?? 'No compatible model found'
            return { ok: false, message: firstError, latencyMs: Date.now() - start, model: '' }
        } finally {
            if (envKey) {
                if (savedKey === undefined) delete process.env[envKey]
                else process.env[envKey] = savedKey
            }
        }
    }

    // ── OpenRouter: test with a :free model first, surface credit errors clearly ──
    if (providerKey === 'openrouter') {
        if (!opts.apiKey) {
            return { ok: false, message: 'OpenRouter requires an API key. Get one at openrouter.ai/keys.', latencyMs: 0, model: '' }
        }
        // Waterfall through free models — some fail if user has 'Model Training' disabled
        // in OpenRouter privacy settings (returns 'No endpoints found matching your data policy').
        const FREE_CANDIDATES = [
            'deepseek/deepseek-chat-v3-0324:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'deepseek/deepseek-r1:free',
            'mistralai/mistral-small-3.1-24b-instruct:free',
            'meta-llama/llama-3.2-3b-instruct:free',
        ]
        const candidates: string[] = []
        if (opts.model && !FREE_CANDIDATES.includes(opts.model)) candidates.push(opts.model)
        for (const m of FREE_CANDIDATES) if (!candidates.includes(m)) candidates.push(m)

        const errors: string[] = []
        for (const candidate of candidates) {
            try {
                const model = buildTestModel('openrouter', candidate, undefined, opts.apiKey)
                const ac = new AbortController()
                const timer = setTimeout(() => ac.abort(), timeoutMs)
                const result = await gt({ model, prompt: 'Reply with the single word "ok".', maxOutputTokens: 20, abortSignal: ac.signal })
                clearTimeout(timer)
                if (result.text.trim().length > 0) {
                    const isUserModel = opts.model === candidate
                    const msg = (!isUserModel && opts.model)
                        ? `Connected via ${candidate} (free tier). Your selected model "${opts.model}" may require credits or be unavailable.`
                        : `Connected — using ${candidate}`
                    return { ok: true, message: msg, latencyMs: Date.now() - start, model: candidate }
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                const lower = msg.toLowerCase()
                if (lower.includes('402') || lower.includes('insufficient credits') || lower.includes('never purchased')) {
                    errors.push(`${candidate}: No credits — add funds at openrouter.ai/credits, or use a :free model`)
                } else if (lower.includes('401') || lower.includes('invalid api key') || lower.includes('no api key')) {
                    return { ok: false, message: 'Invalid API key. Check openrouter.ai/keys.', latencyMs: Date.now() - start, model: candidate }
                } else if (lower.includes('no endpoints found')) {
                    // Model unavailable or blocked by user's privacy settings — try next
                    errors.push(`${candidate}: ${msg.slice(0, 80)}`)
                } else {
                    errors.push(`${candidate}: ${msg.slice(0, 120)}`)
                }
            }
        }
        // All candidates failed — return most useful error
        const creditError = errors.find(e => e.includes('No credits'))
        const privacyError = errors.every(e => e.includes('No endpoints found'))
        const message = creditError
            ? creditError
            : privacyError
                ? 'All free models are blocked by your OpenRouter privacy settings. Enable \'Model Training\' at openrouter.ai/settings/privacy, or add credits to use paid models.'
                : errors[0] ?? 'Connection failed'
        return { ok: false, message, latencyMs: Date.now() - start, model: '' }
    }

    // ── xAI: waterfall through current models; grok-2 is deprecated ────────────
    if (providerKey === 'xai') {
        if (!opts.apiKey) {
            return { ok: false, message: 'xAI requires an API key. Get one at console.x.ai.', latencyMs: 0, model: '' }
        }
        const XAI_CANDIDATES = ['grok-3-mini', 'grok-3', 'grok-4', 'grok-beta']
        const candidates: string[] = []
        if (opts.model && !XAI_CANDIDATES.includes(opts.model)) candidates.push(opts.model)
        for (const m of XAI_CANDIDATES) if (!candidates.includes(m)) candidates.push(m)

        const envKey = PROVIDER_ENV_KEY.xai!
        const savedKey = process.env[envKey]
        process.env[envKey] = opts.apiKey
        const errors: string[] = []
        try {
            for (const candidate of candidates) {
                try {
                    const model = buildTestModel('xai', candidate, opts.baseUrl, opts.apiKey)
                    const ac = new AbortController()
                    const timer = setTimeout(() => ac.abort(), timeoutMs)
                    const result = await gt({ model, prompt: 'Reply with the single word "ok".', maxOutputTokens: 20, abortSignal: ac.signal })
                    clearTimeout(timer)
                    if ((result.text ?? '').trim().length > 0) {
                        return { ok: true, message: `Connected — using ${candidate}`, latencyMs: Date.now() - start, model: candidate }
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    const lower = msg.toLowerCase()
                    // xAI returns HTTP 400 "Bad Request" for invalid keys (body says
                    // "Incorrect API key provided" but the AI SDK flattens it to the
                    // status text). Treat 400/Bad Request on the FIRST candidate as an
                    // auth failure — if the key were valid but the model were wrong,
                    // we'd try the next candidate successfully.
                    if (lower.includes('401') || lower.includes('incorrect api key') || lower.includes('invalid api key') || lower.includes('unauthorized')) {
                        return { ok: false, message: 'Invalid API key. Check console.x.ai.', latencyMs: Date.now() - start, model: candidate }
                    }
                    if (lower.includes('400') || lower.includes('bad request')) {
                        // Retry on next candidate — if ALL candidates return 400, it's almost
                        // certainly an auth failure (xAI's actual error for invalid keys).
                        errors.push(`${candidate}: auth-or-model`)
                        continue
                    }
                    errors.push(`${candidate}: ${msg.slice(0, 120)}`)
                }
            }
            // If every candidate returned 400/auth-or-model, it's an auth failure.
            const allAuthOrModel = errors.length > 0 && errors.every(e => e.includes('auth-or-model'))
            if (allAuthOrModel) {
                return { ok: false, message: 'Invalid API key. Check console.x.ai.', latencyMs: Date.now() - start, model: '' }
            }
            return { ok: false, message: errors[0] ?? 'No compatible xAI model found on your account.', latencyMs: Date.now() - start, model: '' }
        } finally {
            if (savedKey === undefined) delete process.env[envKey]
            else process.env[envKey] = savedKey
        }
    }

    const modelId = opts.model ?? DEFAULT_TEST_MODELS[providerKey] ?? 'default'
    // deepseek-reasoner requires large chain-of-thought token budgets; use deepseek-chat
    // for the smoke test to validate the API key without exhausting the budget.
    const testModelId = (providerKey === 'deepseek' && modelId === 'deepseek-reasoner')
        ? 'deepseek-chat'
        : modelId
    const envKey = PROVIDER_ENV_KEY[providerKey]

    // Inject the key into env for non-Anthropic providers that read it automatically.
    let savedKey: string | undefined
    if (opts.apiKey && envKey && providerKey !== 'anthropic') {
        savedKey = process.env[envKey]
        process.env[envKey] = opts.apiKey
    }
    try {
        // Always pass the key directly so buildTestModel can inject it into
        // headers for providers that don't use env-var injection (cerebras,
        // together, fireworks, perplexity, sambanova, cohere, cloudflare, etc.).
        const model = buildTestModel(providerKey, testModelId, opts.baseUrl, opts.apiKey)
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), timeoutMs)
        const result = await gt({
            model,
            prompt: 'Reply with the single word "ok".',
            maxOutputTokens: 20,
            abortSignal: ac.signal,
        })
        clearTimeout(timer)
        const ok = (result.text ?? '').trim().length > 0
        const connectedMsg = modelId !== testModelId
            ? `Connected — API key valid (tested via ${testModelId})`
            : 'Connected — model responded'
        return { ok, message: ok ? connectedMsg : 'Empty response', latencyMs: Date.now() - start, model: modelId }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'
        return { ok: false, message, latencyMs: Date.now() - start, model: modelId }
    } finally {
        if (envKey) {
            if (savedKey === undefined) delete process.env[envKey]
            else process.env[envKey] = savedKey
        }
    }
}
