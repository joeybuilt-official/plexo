// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Vision capability detection for AI models.
 *
 * Used by both the API (to gate image content parts before sending to a model)
 * and the web frontend (to warn users when attaching images to a non-vision model).
 *
 * The canonical list lives here so there is exactly one source of truth.
 * The web app's MODEL_CAPABILITIES map defers to this for the 'image' flag.
 */

import type { WorkspaceAISettings } from './registry.js'

/**
 * Models known to accept image content parts through their hosted API.
 *
 * Only models reachable via the standard provider SDKs (@ai-sdk/*) are listed.
 * Self-hosted open-weight models (Ollama, vLLM) are handled by the name-based
 * heuristic below — their names typically include "vision", "vl", or "llava".
 */
const VISION_MODELS = new Set([
    // Anthropic
    'claude-opus-4-5',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    // OpenAI
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-4-vision-preview',
    'o1',
    'o3',
    'o4-mini',
    // Google
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    // xAI
    'grok-3',
    'grok-3-mini',
    'grok-2',
    // Groq — vision-capable Llama models (free tier)
    'llama-3.2-11b-vision-preview',
    'llama-3.2-90b-vision-preview',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
])

/**
 * Provider families where the DEFAULT chat model does NOT support vision.
 * Individual models from these providers may still support vision — check
 * modelSupportsVision() with the specific model ID, not the provider alone.
 */
const NO_VISION_PROVIDERS = new Set([
    'deepseek',
    'mistral',
])

/**
 * Check whether a model supports image/vision input.
 *
 * @param modelId   The model identifier (e.g. "gpt-4o", "deepseek-chat")
 * @param provider  Optional provider key for fast-path rejection of text-only providers
 * @returns true if the model can process image content parts
 */
export function modelSupportsVision(modelId: string, provider?: string): boolean {
    // Fast-path: known text-only provider families (their default models never have vision)
    // Note: Groq is NOT in this list — it has vision-capable Llama models
    if (provider && NO_VISION_PROVIDERS.has(provider)) return false

    // Exact match against the known-good set
    if (VISION_MODELS.has(modelId)) return true

    // Heuristic for dynamic / self-hosted / OpenRouter models
    const lower = modelId.toLowerCase()
    if (lower.includes('vision') || lower.includes('-vl') || lower.includes('llava') || lower.includes('pixtral')) return true

    // OpenRouter compound IDs like "anthropic/claude-sonnet-4-5"
    const slash = modelId.lastIndexOf('/')
    if (slash > 0) {
        const bare = modelId.slice(slash + 1)
        if (VISION_MODELS.has(bare)) return true
        // Recurse on the bare model name for heuristic check
        return modelSupportsVision(bare)
    }

    return false
}

/**
 * Recommended free vision model for Groq (no cost, just needs a free API key).
 * Suggested when the user has no vision-capable model configured.
 */
export const GROQ_FREE_VISION_MODEL = 'llama-3.2-90b-vision-preview'

// NOTE: No hardcoded provider-to-vision-model mapping. The user controls their
// provider chain and model selection. Vision model discovery uses the selected
// model, discovered capabilities, and the VISION_MODELS allowlist — nothing else.

/**
 * Find the first vision-capable model across all configured providers.
 *
 * Skips the primary provider (already known to lack vision) and searches
 * the full provider map. Returns the provider key and model ID so the
 * caller can build the model and route the image request to it.
 *
 * @param settings         Workspace AI settings
 * @param defaultModels    Provider default model map (from PROVIDER_DEFAULT_MODELS)
 * @param skipProvider     Provider key to skip (usually the primary, already checked)
 * @returns The first vision-capable {providerKey, modelId} or null if none found
 */
export function findVisionCapableModel(
    settings: WorkspaceAISettings,
    defaultModels: Partial<Record<string, string>>,
    skipProvider?: string,
): { providerKey: string; modelId: string } | null {
    // Search in fallback chain order so the user's priority is respected.
    // Include all configured providers not already in the chain as well.
    const orderedKeys = [
        ...settings.fallbackChain,
        ...Object.keys(settings.providers).filter(k => !settings.fallbackChain.includes(k as any)),
    ]

    for (const providerKey of orderedKeys) {
        if (providerKey === skipProvider) continue
        const config = settings.providers[providerKey as keyof typeof settings.providers]
        if (!config) continue
        if (config.enabled === false) continue

        // First check the selected/default model
        const modelId = config.model ?? defaultModels[providerKey]
        if (modelId && modelSupportsVision(modelId, providerKey)) {
            return { providerKey, modelId }
        }

        // If the selected model doesn't have vision, check all discovered models
        // for this provider. This catches providers that have vision-capable models
        // available even when the selected model is text-only.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const capabilities = (config as any).capabilities as { chatModels?: string[] } | undefined
        if (capabilities?.chatModels) {
            for (const discoveredModel of capabilities.chatModels) {
                if (modelSupportsVision(discoveredModel, providerKey)) {
                    return { providerKey, modelId: discoveredModel }
                }
            }
        }

        // No hardcoded fallback — the user controls their provider chain.
        // If neither the selected model nor any discovered model has vision,
        // this provider is skipped.
    }
    return null
}
