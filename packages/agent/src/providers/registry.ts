import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
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
}

// Use a broad type that works with generateText — all providers return LanguageModelV2 or V3
// which are both accepted by generateText / generateObject in ai@6
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLanguageModel = any

/**
 * Build a LanguageModel instance for a given provider + task type.
 * API keys are read from the config object; falls back to process.env
 * for any provider whose key is not in the config (for local dev).
 */
export function buildModel(
    providerKey: ProviderKey,
    config: AIProviderConfig,
    taskType: TaskType,
    settings: WorkspaceAISettings,
): AnyLanguageModel {
    const modelId = settings.modelOverrides?.[taskType] ?? DEFAULT_MODEL_ROUTING[taskType]

    switch (providerKey) {
        case 'openrouter': {
            const or = createOpenRouter({ apiKey: config.apiKey! })
            return or(modelId)
        }
        case 'anthropic':
            return anthropic(modelId)
        case 'openai':
            return openai(modelId)
        case 'google':
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
            // Use Ollama's OpenAI-compatible endpoint to get V3 spec compatibility
            const ol = createOpenAICompatible({
                name: 'ollama',
                baseURL: (config.baseUrl ?? 'http://localhost:11434') + '/v1',
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
        msg.includes('too many requests')
    )
}
