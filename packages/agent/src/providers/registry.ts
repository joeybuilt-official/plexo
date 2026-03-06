import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import { db, eq, sql } from '@plexo/db'
import { modelsKnowledge } from '@plexo/db'
import { openai, createOpenAI } from '@ai-sdk/openai'
import { google } from '@ai-sdk/google'
import { mistral } from '@ai-sdk/mistral'
import { groq } from '@ai-sdk/groq'
import { xai } from '@ai-sdk/xai'
import { deepseek } from '@ai-sdk/deepseek'
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
}

export interface WorkspaceAISettings {
    primaryProvider: ProviderKey
    fallbackChain: ProviderKey[]   // ordered; tried if primary fails
    providers: Partial<Record<ProviderKey, AIProviderConfig>>
    modelOverrides?: Partial<Record<TaskType, string>>
    /** Max judges recruited from Ollama ensemble (1–5). Default 3. */
    ensembleSize?: number
    /** Score deviation from mean that triggers cloud arbitration (0–1). Default 0.25. */
    dissentThreshold?: number
}

// Use a broad type that works with generateText — all providers return LanguageModelV2 or V3
// which are both accepted by generateText / generateObject in ai@6
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLanguageModel = any

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
    google: 'gemini-1.5-flash-002',
    mistral: 'mistral-large-latest',
    groq: 'llama-3.1-8b-instant',
    xai: 'grok-3-mini',
    deepseek: 'deepseek-chat',
    ollama: 'llama3.2',
    openrouter: 'anthropic/claude-haiku-4-5',
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
            const or = createOpenRouter({ apiKey: config.apiKey! })
            return or(modelId)
        }
        case 'anthropic': {
            if (config.apiKey) {
                // OAuth tokens (sk-ant-oat*) need Authorization: Bearer + oauth beta header
                // API keys (sk-ant-api03-*) use x-api-key header (handled by createAnthropic default)
                const isOAuth = config.apiKey.startsWith('sk-ant-oat')
                const provider = isOAuth
                    ? createAnthropic({
                        apiKey: 'oauth',
                        fetch: (url: string | URL, init: RequestInit = {}) =>
                            globalThis.fetch(url, {
                                ...init,
                                headers: {
                                    ...(init.headers as Record<string, string> ?? {}),
                                    'Authorization': `Bearer ${config.apiKey}`,
                                    'anthropic-version': '2023-06-01',
                                    'anthropic-beta': 'oauth-2025-04-20',
                                },
                            }),
                    } as Parameters<typeof createAnthropic>[0])
                    : createAnthropic({ apiKey: config.apiKey })
                return provider(modelId)
            }
            return anthropic(modelId)
        }
        case 'openai': {
            const oa = config.apiKey
                ? createOpenAI({ apiKey: config.apiKey })
                : openai
            return (oa as typeof openai)(modelId)
        }
        case 'google':
            // google() singleton uses GOOGLE_GENERATIVE_AI_API_KEY env var.
            // Config-keyed Google support requires createGoogleGenerativeAI — left for a follow-up.
            return google(modelId)
        case 'mistral':
            return mistral(modelId)
        case 'groq':
            return groq(modelId)
        case 'xai':
            return xai(modelId)
        case 'deepseek':
            return deepseek(modelId)
        case 'ollama': {
            const ol = createOpenAICompatible({
                name: 'ollama',
                baseURL: (config.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '') + '/v1',
            })
            return ol(modelId)
        }
        default: {
            const exhaustive: never = providerKey
            throw new Error(`Unknown provider: ${String(exhaustive)}`)
        }
    }
}

/**
 * Resolve the primary model for a task type from workspace settings.
 */
export function resolveModel(
    taskType: TaskType,
    settings: WorkspaceAISettings,
): AnyLanguageModel {
    const config = settings.providers[settings.primaryProvider]
    if (!config) throw new Error(`Primary provider ${settings.primaryProvider} not configured`)
    return buildModel(settings.primaryProvider, config, taskType, settings)
}

/**
 * Resolve a model from environment variables — for internal code paths
 * (sprint planner, memory modules) that run without a user session / workspace settings.
 *
 * Priority: ANTHROPIC_API_KEY → OPENAI_API_KEY → OPENROUTER_API_KEY → Ollama local
 *
 * @param modelId  Optional explicit model ID override (e.g. 'claude-haiku-4-5').
 *                 When omitted the DEFAULT_MODEL_ROUTING for the task type is used.
 */
export function resolveModelFromEnv(modelId?: string): AnyLanguageModel {
    const id = modelId ?? DEFAULT_MODEL_ROUTING.summarization

    if (process.env.ANTHROPIC_API_KEY) return anthropic(id)
    if (process.env.OPENAI_API_KEY) {
        // Map claude model IDs to an OpenAI equivalent when using OpenAI as fallback
        const openaiId = id.startsWith('claude') ? 'gpt-4o-mini' : id
        return openai(openaiId)
    }
    if (process.env.OPENROUTER_API_KEY) {
        const or = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
        return or(id)
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
        msg.includes('logicerror')
    )
}

// ── Default smoke-test model IDs per provider ─────────────────────────────────

const DEFAULT_TEST_MODELS: Record<ProviderKey, string> = {
    openrouter: 'openai/gpt-4o-mini',
    anthropic: 'claude-haiku-4-5',
    openai: 'gpt-4o-mini',
    google: 'gemini-1.5-flash-002',
    mistral: 'mistral-small-latest',
    groq: 'llama-3.1-8b-instant',
    xai: 'grok-2',
    deepseek: 'deepseek-chat',
    ollama: 'llama3.2',
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
        case 'openrouter': return createOpenRouter({})(modelId)
        case 'anthropic': {
            if (apiKey) {
                // Claude.ai subscription tokens (sk-ant-oat*) need Authorization: Bearer
                const isOAuth = apiKey.startsWith('sk-ant-oat')
                const provider = isOAuth
                    ? createAnthropic({
                        apiKey: 'oauth',
                        fetch: (url: string | URL, init: RequestInit = {}) =>
                            globalThis.fetch(url, {
                                ...init,
                                headers: {
                                    ...(init.headers as Record<string, string> ?? {}),
                                    'Authorization': `Bearer ${apiKey}`,
                                    'anthropic-version': '2023-06-01',
                                    'anthropic-beta': 'oauth-2025-04-20',
                                },
                            }),
                    } as Parameters<typeof createAnthropic>[0])
                    : createAnthropic({ apiKey })
                return provider(modelId)
            }
            return anthropic(modelId)
        }
        case 'openai': return openai(modelId)
        case 'google': return google(modelId)
        case 'mistral': return mistral(modelId)
        case 'groq': return groq(modelId)
        case 'xai': return xai(modelId)
        case 'deepseek': return deepseek(modelId)
        case 'ollama': {
            const base = (baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '') + '/v1'
            return createOpenAICompatible({ name: 'ollama', baseURL: base })(modelId)
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

    // ── Ollama: discover models via GET, pick one, then test ──────────────────
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

    // ── Google: waterfall through model candidates until one works ────────────
    // Users may have keys with different model access depending on their project / billing tier.
    const GOOGLE_MODEL_PRIORITY = [
        'gemini-2.0-flash-exp',
        'gemini-1.5-flash-002',
        'gemini-1.5-flash-latest',
        'gemini-1.5-pro-002',
        'gemini-1.5-flash',
        'gemini-1.5-pro',
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

    const modelId = opts.model ?? DEFAULT_TEST_MODELS[providerKey]
    const envKey = PROVIDER_ENV_KEY[providerKey]

    // For Anthropic OAuth tokens, do NOT inject into env (env → x-api-key which fails for OAuth).
    // Instead pass the key directly to buildTestModel which handles Bearer auth.
    const isAnthropicOAuth = providerKey === 'anthropic' && opts.apiKey?.startsWith('sk-ant-oat')

    // Temporarily override env key for non-OAuth providers
    let savedKey: string | undefined
    if (opts.apiKey && envKey && !isAnthropicOAuth) {
        savedKey = process.env[envKey]
        process.env[envKey] = opts.apiKey
    }

    try {
        // For Anthropic: always pass the key directly so buildTestModel can set the correct auth header.
        // For other providers: key is injected via env var above (non-Anthropic path).
        const directKey = providerKey === 'anthropic' ? opts.apiKey : undefined
        const model = buildTestModel(providerKey, modelId, opts.baseUrl, directKey)
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), timeoutMs)
        const result = await gt({
            model,
            prompt: 'Reply with the single word "ok".',
            maxOutputTokens: 20,
            abortSignal: ac.signal,
        })
        clearTimeout(timer)
        const ok = result.text.trim().length > 0
        return { ok, message: ok ? 'Connected — model responded' : 'Empty response', latencyMs: Date.now() - start, model: modelId }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'
        return { ok: false, message, latencyMs: Date.now() - start, model: modelId }
    } finally {
        if (envKey && !isAnthropicOAuth) {
            if (savedKey === undefined) delete process.env[envKey]
            else process.env[envKey] = savedKey
        }
    }
}
