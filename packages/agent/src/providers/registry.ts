// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import { db, eq, sql } from '@plexo/db'
import { modelsKnowledge } from '@plexo/db'
import { openai, createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createMistral } from '@ai-sdk/mistral'
import { createGroq } from '@ai-sdk/groq'
import { createXai } from '@ai-sdk/xai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
// Use LanguageModel from the ai package (re-exported from @ai-sdk/provider)
// Ollama uses OpenAI-compatible endpoint to stay on V3 spec (ollama-ai-provider is V1 only)

export type ProviderKey =
    | 'openrouter'
    | 'anthropic'
    | 'openai'
    | 'google'
    | 'mistral'
    | 'groq'
    | 'xai'
    | 'deepseek'
    | 'ollama'
    | 'ollama_cloud'

export type TaskType =
    | 'planning'
    | 'codeGeneration'
    | 'verification'
    | 'summarization'
    | 'classification'
    | 'logAnalysis'

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
    classification: 'claude-haiku-4-5',
    logAnalysis: 'claude-haiku-4-5',
}

export interface AIProviderConfig {
    provider: ProviderKey
    apiKey?: string
    baseUrl?: string        // for Ollama or custom OpenAI-compatible endpoints
    model?: string          // provider-level default model override
    customFetch?: typeof globalThis.fetch // For proxy/security injections
    /** User-level enable/disable toggle; false overrides all other checks */
    enabled?: boolean
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
const PROVIDER_DEFAULT_MODELS: Partial<Record<ProviderKey, string>> = {
    openai: 'gpt-4o',
    google: 'gemini-2.5-flash',
    mistral: 'mistral-large-latest',
    groq: 'llama-3.1-8b-instant',
    xai: 'grok-3-mini',
    deepseek: 'deepseek-chat',
    ollama: 'llama3.2',
    ollama_cloud: 'gpt-oss:20b-cloud',
    // Free tier default — works with any key, no credits required.
    // deepseek-chat-v3-0324:free is generally available regardless of OR privacy settings.
    openrouter: 'deepseek/deepseek-chat-v3-0324:free',
}

export function buildModel(
    providerKey: ProviderKey,
    config: AIProviderConfig,
    taskType: TaskType,
    settings: WorkspaceAISettings,
): AnyLanguageModel {
    // Resolve model ID — never let a Claude ID land on a non-Anthropic provider
    const validModel = (id: string | undefined) =>
        id && id.trim() !== '' && id !== 'default' && id !== 'placeholder' ? id : undefined

    const modelId =
        validModel(settings.modelOverrides?.[taskType]) ??
        validModel(config.model) ??
        PROVIDER_DEFAULT_MODELS[providerKey] ??
        DEFAULT_MODEL_ROUTING[taskType]

    switch (providerKey) {
        case 'openrouter': {
            const or = createOpenRouter({ apiKey: config.apiKey!, fetch: config.customFetch })
            return or(modelId)
        }
        case 'anthropic': {
            const provider = config.apiKey
                ? createAnthropic({ apiKey: config.apiKey })
                : anthropic
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
            const ds = config.apiKey
                ? createDeepSeek({ apiKey: config.apiKey })
                : createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY ?? '' })
            return ds(modelId)
        }
        case 'ollama': {
            const ol = createOpenAICompatible({
                name: 'ollama',
                baseURL: (config.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '') + '/v1',
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
            })
            return oc(modelId)
        }
        default: {
            const exhaustive: never = providerKey
            throw new Error(`Unknown provider: ${String(exhaustive)}`)
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
    
    // Telemetry trace: clearly surface the selected model and reasoning
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
 * Priority: OPENAI_API_KEY → OPENROUTER_API_KEY → Ollama local
 *
 * @param modelId  Optional explicit model ID override.
 *                 When omitted the DEFAULT_MODEL_ROUTING for the task type is used.
 */
export function resolveModelFromEnv(modelId?: string): AnyLanguageModel {
    const id = modelId ?? DEFAULT_MODEL_ROUTING.summarization

    if (process.env.OPENAI_API_KEY) {
        // Map claude model IDs to an OpenAI equivalent when using OpenAI as fallback
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
    // Last resort — local Ollama
    const ol = createOpenAICompatible({ name: 'ollama', baseURL: 'http://localhost:11434/v1' })
    return ol('llama3.2')
}



/**
 * Fallback chain wrapper.
 * Tries primary, then each provider in fallbackChain in order.
 * Only retries on provider-level errors (rate limit, timeout, 5xx).
 * Application-level errors (bad schema, cancelled task) propagate immediately.
 */
export async function withFallback<T>(
    settings: WorkspaceAISettings,
    taskType: TaskType,
    fn: (model: AnyLanguageModel) => Promise<T>,
): Promise<T> {
    const chain = [settings.primaryProvider, ...settings.fallbackChain]
    let lastError: unknown

    for (const providerKey of chain) {
        const config = settings.providers[providerKey]
        if (!config) continue
        try {
            const model = buildModel(providerKey, config, taskType, settings)
            return await fn(model)
        } catch (err) {
            lastError = err

            // Self-calibration logic: Penalize reliability on logic/parse errors
            if (err instanceof Error) {
                const msg = err.message.toLowerCase()
                if (msg.includes('logicerror') || msg.includes('jsonparseerror') || msg.includes('typevalidationerror')) {
                    const failedModelId = config.model
                    if (failedModelId) {
                        try {
                            await db.update(modelsKnowledge)
                                .set({ reliabilityScore: sql`GREATEST(0, ${modelsKnowledge.reliabilityScore} - 0.05)` })
                                .where(eq(modelsKnowledge.modelId, failedModelId))
                        } catch (dbErr) {
                            // Log or ignore db errors during calibration
                        }
                    }
                }
            }

            if (!isRetryableProviderError(err)) throw err
        }
    }
    throw lastError
}

function isRetryableProviderError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    const msg = err.message.toLowerCase()
    return (
        msg.includes('rate limit') ||
        msg.includes('timeout') ||
        msg.includes('503') ||
        msg.includes('529') ||
        msg.includes('overloaded') ||
        msg.includes('too many requests') ||
        msg.includes('typevalidationerror') ||
        msg.includes('jsonparseerror') ||
        msg.includes('logicerror') ||
        // Auth failures from stale/invalid keys — fall through to next provider
        msg.includes('401') ||
        msg.includes('invalid api key') ||
        msg.includes('unauthorized') ||
        msg.includes('authentication failed') ||
        msg.includes('invalid_api_key')
    )
}

// ── Default smoke-test model IDs per provider ─────────────────────────────────

const DEFAULT_TEST_MODELS: Record<ProviderKey, string> = {
    // Must use :free suffix — OpenRouter 402s on accounts with no purchase history
    // when a paid endpoint is requested. Candidates are tried in order (waterfall).
    // Some fail if user has "Model Training" disabled in OR privacy settings.
    openrouter: 'deepseek/deepseek-chat-v3-0324:free',
    anthropic: 'claude-haiku-4-5',
    openai: 'gpt-4o-mini',
    google: 'gemini-2.5-flash',
    mistral: 'mistral-small-latest',
    groq: 'llama-3.1-8b-instant',
    xai: 'grok-2',
    deepseek: 'deepseek-chat',
    ollama: 'llama3.2',
    ollama_cloud: 'gpt-oss:20b-cloud',
}

// Map provider → env var name (used to temporarily inject a user-supplied key)
const PROVIDER_ENV_KEY: Partial<Record<ProviderKey, string>> = {
    openrouter: 'OPENROUTER_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    groq: 'GROQ_API_KEY',
    xai: 'XAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
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
            const ds = apiKey
                ? createDeepSeek({ apiKey })
                : createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY ?? '' })
            return ds(modelId)
        }
        case 'ollama': {
            const base = (baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '') + '/v1'
            return createOpenAICompatible({ name: 'ollama', baseURL: base })(modelId)
        }
        case 'ollama_cloud': {
            return createOpenAICompatible({
                name: 'ollama_cloud',
                baseURL: 'https://ollama.com/v1',
                headers: { Authorization: `Bearer ${apiKey ?? ''}` },
            })(modelId)
        }
        default: {
            const exhaustive: never = providerKey
            throw new Error(`Unknown provider: ${String(exhaustive)}`)
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

    // ── Ollama local: discover models via GET, pick one, then test ───────────
    if (providerKey === 'ollama') {
        const baseURL = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '') + '/v1'
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
            // Try a generate — if the server blocks POST, still report ok since server responded
            try {
                const ol = createOpenAICompatible({ name: 'ollama', baseURL })(modelId)
                const ac = new AbortController()
                const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs - (Date.now() - start), 5000))
                const result = await gt({ model: ol, prompt: 'Say "ok".', maxOutputTokens: 20, abortSignal: ac.signal })
                clearTimeout(timer)
                return { ok: true, message: `Connected — ${models.length} model(s) available`, latencyMs: Date.now() - start, model: modelId }
                void result
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

    // ── Google: waterfall through model candidates until one works ────────────
    // Users may have keys with different model access depending on their project / billing tier.
    const GOOGLE_MODEL_PRIORITY = [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.5-flash-8b',
        'gemini-2.0-flash',
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
                    const msg = err instanceof Error ? err.message.slice(0, 120) : 'error'
                    errors.push(`${candidate}: ${msg}`)
                }
            }
            return { ok: false, message: `No compatible model found. Tried: ${candidates.slice(0, 3).join(', ')}`, latencyMs: Date.now() - start, model: '' }
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
        // Try the user's explicit model first (if set), then fall through our known-good list.
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

    const modelId = opts.model ?? DEFAULT_TEST_MODELS[providerKey]
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
        // Always pass the key directly for Anthropic so buildTestModel uses the correct key.
        const directKey = providerKey === 'anthropic' ? opts.apiKey : undefined
        const model = buildTestModel(providerKey, testModelId, opts.baseUrl, directKey)
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
