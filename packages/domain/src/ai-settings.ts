// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace AI provider vocabulary — the pure type ring shared by
 * `@plexo/agent` (provider registry + router) and `@plexo/queue` (inngest
 * event schemas). Framework-free: no SDK, DB, or IO imports (ADR-0045).
 */

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
