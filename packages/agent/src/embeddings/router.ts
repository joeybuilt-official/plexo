// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * EmbeddingRouter — provider-agnostic embedding resolution.
 *
 * Resolves the best available embedding provider from a workspace's
 * configured AI providers. Both the memory store and SCL layer consume
 * this router. Neither has direct knowledge of which concrete provider
 * handles the call.
 *
 * Resolution order:
 * 1. Walk workspace's provider chain (primary + fallback) in order
 * 2. For each: check if provider supports embeddings AND has valid credentials
 * 3. Return first match
 * 4. If nothing matches: return null (hash fallback is caller's decision, never silent)
 */

import pino from 'pino'
import type { WorkspaceAISettings, ProviderKey, AIProviderConfig } from '../providers/registry.js'
import { resolveBaseUrl } from '../providers/registry.js'
import {
    type EmbeddingAdapter,
    type EmbeddingProviderStatus,
    GatewayEmbeddingAdapter,
    OpenAIEmbeddingAdapter,
    GoogleEmbeddingAdapter,
    MistralEmbeddingAdapter,
    VoyageEmbeddingAdapter,
    CohereEmbeddingAdapter,
    OllamaEmbeddingAdapter,
    OpenRouterEmbeddingAdapter,
    EMBEDDING_CAPABLE_PROVIDERS,
    DEFAULT_EMBEDDING_MODELS,
} from './adapters.js'
import { XenovaEmbeddingAdapter } from './xenova-adapter.js'

// Xenova is opt-IN. Set XENOVA_EMBEDDER=1 to force the in-process ONNX
// adapter; otherwise the resolver prefers the bundled gateway (EMBEDDINGS_URL),
// workspace-configured providers, or env-var providers. The opt-out default
// caused silent embed() failures whenever the ONNX backend was missing —
// a container without the var fell through to a broken adapter and 502'd.
// Gateway-first is the safer default; Xenova stays available for ops that
// explicitly want zero-dependency inference.
function isXenovaEnabled(): boolean {
    return process.env.XENOVA_EMBEDDER === '1'
}

function buildXenovaResolution(workspaceId: string): EmbeddingRouterResult {
    const adapter = new XenovaEmbeddingAdapter()
    logger.info({ workspaceId, provider: adapter.providerId, model: adapter.model, dimensions: adapter.dimensions }, 'Embedding provider resolved to Xenova/multilingual-e5-small (Phase 1 default)')
    return {
        adapter,
        providerId: adapter.providerId,
        model: adapter.model,
        dimensions: adapter.dimensions,
        status: 'active',
        message: 'Resolved from Xenova/multilingual-e5-small (Phase 1 default; set XENOVA_EMBEDDER=0 to disable)',
    }
}

const logger = pino({ name: 'embeddings:router' })

export interface EmbeddingResolution {
    adapter: EmbeddingAdapter
    status: EmbeddingProviderStatus
    message: string | null
}

export interface EmbeddingRouterResult {
    /** The resolved adapter, or null if no real provider is available */
    adapter: EmbeddingAdapter | null
    /** Provider ID of the resolved adapter (null if hash fallback) */
    providerId: string | null
    /** Embedding model used */
    model: string | null
    /** Dimension count of the resolved adapter */
    dimensions: number | null
    /** Status for introspection */
    status: EmbeddingProviderStatus
    /** Human-readable explanation */
    message: string | null
}

/**
 * Docker-aware base URL resolution for Ollama.
 * Uses the same resolveBaseUrl from the LLM provider registry to ensure
 * consistent localhost→Docker-host rewriting for both LLM and embedding calls.
 * Also checks OLLAMA_INTERNAL_URL (set in docker-compose for the managed sidecar).
 */
function resolveOllamaBaseUrl(configuredUrl?: string): string {
    // If no URL configured, prefer the internal Docker DNS name (set in compose)
    // over localhost — this is the most reliable path from inside the container.
    if (!configuredUrl) {
        const internalUrl = process.env.OLLAMA_INTERNAL_URL
        if (internalUrl) return internalUrl.replace(/\/+$/, '')
    }
    const base = (configuredUrl || 'http://localhost:11434').replace(/\/+$/, '')
    // Delegate to the same rewrite logic the LLM provider uses
    return resolveBaseUrl(base)
}

/**
 * Check if a credential looks valid (non-empty, non-placeholder).
 */
function isValidKey(key: string | undefined): key is string {
    return !!key && key.length > 5 && key !== 'placeholder' && !key.includes(' ')
}

/**
 * Build an embedding adapter for a specific provider, given its config.
 * Returns null if the provider doesn't support embeddings or lacks credentials.
 */
function buildAdapter(providerKey: string, config: AIProviderConfig): EmbeddingAdapter | null {
    const key = providerKey.startsWith('custom_') ? 'custom' : providerKey

    if (!EMBEDDING_CAPABLE_PROVIDERS.has(key) && !providerKey.startsWith('custom_')) return null

    const apiKey = config.apiKey
    const baseUrl = config.baseUrl
    const defaults = DEFAULT_EMBEDDING_MODELS[key]

    switch (key) {
        case 'plexo-gateway': {
            // EMBEDDINGS_URL is the new name; INFERENCE_GATEWAY_URL kept as
            // a deprecation fallback for one release so existing .env files
            // keep working.
            const gwUrl = baseUrl || process.env.EMBEDDINGS_URL || process.env.INFERENCE_GATEWAY_URL
            if (!gwUrl) return null
            return new GatewayEmbeddingAdapter(
                gwUrl,
                defaults?.model ?? 'plexo-embed-v1',
                defaults?.dimensions ?? 384,
            )
        }

        case 'openai':
            if (!isValidKey(apiKey)) return null
            return new OpenAIEmbeddingAdapter(apiKey, baseUrl ? `${baseUrl.replace(/\/+$/, '')}/v1` : undefined)

        case 'google':
            if (!isValidKey(apiKey)) return null
            return new GoogleEmbeddingAdapter(apiKey)

        case 'mistral':
            if (!isValidKey(apiKey)) return null
            return new MistralEmbeddingAdapter(apiKey)

        case 'voyage':
            if (!isValidKey(apiKey)) return null
            return new VoyageEmbeddingAdapter(apiKey)

        case 'cohere':
            if (!isValidKey(apiKey)) return null
            return new CohereEmbeddingAdapter(apiKey)

        case 'ollama':
        case 'ollama_cloud': {
            const resolvedUrl = resolveOllamaBaseUrl(baseUrl)
            logger.debug({ provider: key, configuredUrl: baseUrl, resolvedUrl }, 'Building Ollama embedding adapter')
            return new OllamaEmbeddingAdapter(
                resolvedUrl,
                defaults?.model ?? 'nomic-embed-text',
                defaults?.dimensions ?? 768,
                key,
            )
        }

        case 'openrouter':
            if (!isValidKey(apiKey)) return null
            return new OpenRouterEmbeddingAdapter(apiKey)

        default:
            // custom_* providers: try OpenAI-compatible embedding if they have a base URL and key
            if (providerKey.startsWith('custom_') && isValidKey(apiKey) && baseUrl) {
                return new OpenAIEmbeddingAdapter(apiKey, `${baseUrl.replace(/\/+$/, '')}/v1`, 'text-embedding-3-small', 1536)
            }
            return null
    }
}

// ── Env-var fallback (for code paths without workspace settings) ─────────────

const PROVIDER_ENV_VARS: Array<{ provider: string; envVar: string }> = [
    { provider: 'openai', envVar: 'OPENAI_API_KEY' },
    { provider: 'google', envVar: 'GOOGLE_GENERATIVE_AI_API_KEY' },
    { provider: 'google', envVar: 'GEMINI_API_KEY' },
    { provider: 'mistral', envVar: 'MISTRAL_API_KEY' },
    { provider: 'voyage', envVar: 'VOYAGE_API_KEY' },
    { provider: 'cohere', envVar: 'COHERE_API_KEY' },
]

function resolveFromEnv(): EmbeddingAdapter | null {
    // Highest priority: Plexo's bundled embeddings server (zero cost, no API key needed).
    // EMBEDDINGS_URL is the new name; INFERENCE_GATEWAY_URL kept as a deprecation fallback.
    const gatewayUrl = process.env.EMBEDDINGS_URL || process.env.INFERENCE_GATEWAY_URL
    if (gatewayUrl) {
        const gwDefaults = DEFAULT_EMBEDDING_MODELS['plexo-gateway']
        const adapter = new GatewayEmbeddingAdapter(
            gatewayUrl,
            gwDefaults?.model ?? 'plexo-embed-v1',
            gwDefaults?.dimensions ?? 384,
        )
        logger.info({ provider: 'plexo-embeddings', url: gatewayUrl }, 'Embedding provider resolved from EMBEDDINGS_URL')
        return adapter
    }

    for (const { provider, envVar } of PROVIDER_ENV_VARS) {
        const key = process.env[envVar]
        if (!isValidKey(key)) continue
        const defaults = DEFAULT_EMBEDDING_MODELS[provider]
        if (!defaults) continue

        const fakeConfig: AIProviderConfig = { provider: provider as ProviderKey, apiKey: key }
        const adapter = buildAdapter(provider, fakeConfig)
        if (adapter) {
            logger.info({ provider, envVar }, 'Embedding provider resolved from env var')
            return adapter
        }
    }

    // Ollama doesn't need an API key — check if OLLAMA_INTERNAL_URL is set (docker-compose sidecar)
    const ollamaUrl = process.env.OLLAMA_INTERNAL_URL
    if (ollamaUrl) {
        const adapter = buildAdapter('ollama', { provider: 'ollama' as ProviderKey, baseUrl: ollamaUrl })
        if (adapter) {
            logger.info({ provider: 'ollama', url: ollamaUrl }, 'Embedding provider resolved from OLLAMA_INTERNAL_URL')
            return adapter
        }
    }

    return null
}

// ── Main resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the best available embedding provider for a workspace.
 *
 * @param workspaceId - workspace to resolve for (for logging)
 * @param aiSettings - workspace AI settings (provider configs with decrypted keys)
 * @returns Resolution result. adapter is null if no real provider is available.
 */
export function resolveEmbeddingAdapter(
    workspaceId: string,
    aiSettings: WorkspaceAISettings | null,
): EmbeddingRouterResult {
    // Phase 1 lock — Xenova/multilingual-e5-small (384-d, multilingual,
    // pure-JS ONNX). No external dependency, no key. This is the floor;
    // every other branch below is now a legacy escape hatch.
    if (isXenovaEnabled()) {
        return buildXenovaResolution(workspaceId)
    }

    // Highest priority: Plexo's bundled embeddings server. Zero cost, no
    // keys, runs on the same docker network as the api. Preferred over any
    // workspace-configured provider because it removes an entire failure
    // class (external provider outages can't starve the memory pipeline).
    // EMBEDDINGS_URL is the new name; INFERENCE_GATEWAY_URL kept as a
    // deprecation fallback for one release.
    const gatewayUrl = process.env.EMBEDDINGS_URL || process.env.INFERENCE_GATEWAY_URL
    if (gatewayUrl) {
        const gwDefaults = DEFAULT_EMBEDDING_MODELS['plexo-gateway']
        const adapter = new GatewayEmbeddingAdapter(
            gatewayUrl,
            gwDefaults?.model ?? 'plexo-embed-v1',
            gwDefaults?.dimensions ?? 384,
        )
        logger.info({ workspaceId, provider: 'plexo-embeddings', url: gatewayUrl }, 'Embedding provider resolved from EMBEDDINGS_URL (top priority)')
        return {
            adapter,
            providerId: adapter.providerId,
            model: adapter.model,
            dimensions: adapter.dimensions,
            status: 'active',
            message: 'Resolved from Plexo embeddings server',
        }
    }

    if (aiSettings) {
        const chain = [
            aiSettings.primaryProvider,
            ...aiSettings.fallbackChain.filter(p => p !== aiSettings.primaryProvider),
        ]

        for (const providerKey of chain) {
            const config = aiSettings.providers[providerKey]
            if (!config) continue
            if (config.enabled === false) continue

            const adapter = buildAdapter(providerKey, config)
            if (adapter) {
                logger.info({
                    workspaceId,
                    provider: adapter.providerId,
                    model: adapter.model,
                    dimensions: adapter.dimensions,
                }, 'Embedding provider resolved from workspace config')
                return {
                    adapter,
                    providerId: adapter.providerId,
                    model: adapter.model,
                    dimensions: adapter.dimensions,
                    status: 'active',
                    message: null,
                }
            }
        }
    }

    // Fallback: try env vars (for operators who set keys in compose but not in UI)
    const envAdapter = resolveFromEnv()
    if (envAdapter) {
        return {
            adapter: envAdapter,
            providerId: envAdapter.providerId,
            model: envAdapter.model,
            dimensions: envAdapter.dimensions,
            status: 'active',
            message: 'Resolved from environment variable (not workspace config)',
        }
    }

    // No provider available
    logger.warn({
        workspaceId,
    }, 'No embeddings-capable provider configured for workspace. Configure OpenAI, Voyage, Cohere, Google, Mistral, or Ollama with an embedding model to enable semantic memory. Falling back to hash vectors (semantic matching disabled).')

    return {
        adapter: null,
        providerId: null,
        model: null,
        dimensions: null,
        status: 'not-configured',
        message: 'No embeddings-capable provider configured. Configure OpenAI, Voyage, Cohere, Google, Mistral, or Ollama to enable semantic memory.',
    }
}

/**
 * Resolve for code paths that don't have workspace settings
 * (e.g., background jobs, memory summarization).
 */
export function resolveEmbeddingAdapterFromEnv(workspaceId: string): EmbeddingRouterResult {
    return resolveEmbeddingAdapter(workspaceId, null)
}

/**
 * Async resolver that loads workspace settings from DB when not provided.
 * Use this in fire-and-forget paths (storeMemory, conversation-bridge) where
 * aiSettings may not be available from the caller.
 */
export async function resolveEmbeddingAdapterAsync(
    workspaceId: string,
    aiSettings?: WorkspaceAISettings | null,
): Promise<EmbeddingRouterResult> {
    // If settings provided, use sync path
    if (aiSettings) return resolveEmbeddingAdapter(workspaceId, aiSettings)

    // Try env vars first (fast path)
    const envResult = resolveEmbeddingAdapter(workspaceId, null)
    if (envResult.status === 'active') return envResult

    // Try provider_instances table (canonical source after Intelligence page migration)
    try {
        const { loadSettingsFromInstances } = await import('../providers/settings-from-instances.js')
        const instanceSettings = await loadSettingsFromInstances(workspaceId)
        if (instanceSettings) {
            const instanceResult = resolveEmbeddingAdapter(workspaceId, instanceSettings)
            if (instanceResult.status === 'active') return instanceResult
        }
    } catch (err) {
        logger.debug({ err, workspaceId }, 'provider_instances load failed — trying vault/arbiter')
    }

    // Fallback: vault/arbiter JSONB (legacy path)
    try {
        const { db } = await import('@plexo/db')
        const { eq } = await import('drizzle-orm')
        const { workspaces } = await import('@plexo/db')
        const [row] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        const settings = row?.settings as Record<string, unknown> | null
        if (settings) {
            const vault = (settings.vault ?? {}) as Record<string, Record<string, unknown>>
            const arbiter = (settings.arbiter ?? {}) as Record<string, unknown>
            const arbiterProviders = (arbiter.providers ?? {}) as Record<string, Record<string, unknown>>

            const providers: Record<string, AIProviderConfig> = {}
            for (const [key, entry] of Object.entries(vault)) {
                providers[key] = {
                    provider: key as ProviderKey,
                    apiKey: entry?.apiKey as string | undefined,
                    baseUrl: entry?.baseUrl as string | undefined,
                    enabled: (arbiterProviders[key]?.enabled as boolean | undefined) ?? true,
                    model: (arbiterProviders[key]?.selectedModel as string | undefined),
                }
            }

            // No hard-coded provider default: fall back to the first provider the
            // user has actually configured a credential for, not anthropic.
            const configuredPrimary = (arbiter.primaryProvider as ProviderKey | undefined)
                ?? (Object.keys(providers)[0] as ProviderKey | undefined)
            const dbSettings: WorkspaceAISettings = {
                primaryProvider: configuredPrimary as ProviderKey,
                fallbackChain: ((arbiter.fallbackChain ?? []) as string[]) as ProviderKey[],
                providers,
            }

            const dbResult = resolveEmbeddingAdapter(workspaceId, dbSettings)
            if (dbResult.status === 'active') return dbResult
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to load workspace settings for embedding resolution')
    }

    // Final fallback: managed Ollama sidecar
    return tryManagedOllamaFallback(workspaceId)
}

/**
 * Try the managed Ollama sidecar as embedding fallback.
 * Returns not-configured if managed Ollama is unavailable or has no embedding models.
 */
async function tryManagedOllamaFallback(workspaceId: string): Promise<EmbeddingRouterResult> {
    try {
        const { getManagedOllama } = await import('../ollama/managed.js')
        const managed = await getManagedOllama()
        if (!managed) {
            return {
                adapter: null,
                providerId: null,
                model: null,
                dimensions: null,
                status: 'not-configured',
                message: 'No embeddings-capable provider configured and managed Ollama is not reachable.',
            }
        }

        const caps = managed.capabilities
        if (!caps?.supportsEmbeddings || caps.embeddingModels.length === 0) {
            return {
                adapter: null,
                providerId: null,
                model: null,
                dimensions: null,
                status: 'not-configured',
                message: 'Managed Ollama has no embedding models. Pull snowflake-arctic-embed or nomic-embed-text.',
            }
        }

        // Build an EmbeddingAdapter wrapper around the managed OllamaAdapter
        const embModel = caps.embeddingModels[0]!
        const dims = managed.dimensions(embModel)
        const adapter: EmbeddingAdapter = {
            providerId: 'managed-ollama',
            model: embModel,
            dimensions: dims ?? 1024,
            async embed(text: string): Promise<number[]> {
                const result = await managed.embed(text, embModel)
                return result.vector
            },
        }

        logger.info({ workspaceId, model: embModel, dimensions: dims }, 'Embedding resolved via managed Ollama fallback')

        return {
            adapter,
            providerId: 'managed-ollama',
            model: embModel,
            dimensions: dims,
            status: 'active',
            message: 'Resolved via managed Ollama (automatic fallback)',
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Managed Ollama fallback failed')
        return {
            adapter: null,
            providerId: null,
            model: null,
            dimensions: null,
            status: 'not-configured',
            message: 'No embeddings-capable provider configured. Configure OpenAI, Voyage, Cohere, Google, Mistral, or Ollama to enable semantic memory.',
        }
    }
}

// ── Dimension consistency check ─────────────────────────────────────────────

export interface DimensionCheck {
    compatible: boolean
    currentDimensions: number
    recordDimensions: number | null
    message: string | null
}

/**
 * Check if the current embedding provider's dimensions match what's stored
 * in the Golden Record. If they don't match, mutations should be refused.
 */
export function checkDimensionCompatibility(
    adapterDimensions: number,
    recordEmbeddingDimensions: number | undefined | null,
): DimensionCheck {
    if (!recordEmbeddingDimensions) {
        // No existing dimensions recorded — first use, compatible
        return {
            compatible: true,
            currentDimensions: adapterDimensions,
            recordDimensions: null,
            message: null,
        }
    }

    if (adapterDimensions === recordEmbeddingDimensions) {
        return {
            compatible: true,
            currentDimensions: adapterDimensions,
            recordDimensions: recordEmbeddingDimensions,
            message: null,
        }
    }

    return {
        compatible: false,
        currentDimensions: adapterDimensions,
        recordDimensions: recordEmbeddingDimensions,
        message: `Embedding dimension mismatch: current provider produces ${adapterDimensions}-dim vectors but Golden Record contains ${recordEmbeddingDimensions}-dim vectors. Re-embedding required before new mutations can be applied.`,
    }
}

/**
 * Check if the current provider matches the Golden Record's recorded lineage.
 * Same-dimension different-provider produces vectors in different embedding spaces.
 */
export function checkProviderLineage(
    currentProvider: string,
    currentDimensions: number,
    record: { embeddingProvider?: string; embeddingModel?: string; embeddingDimensions?: number },
): DimensionCheck & { providerChanged: boolean } {
    const dimCheck = checkDimensionCompatibility(currentDimensions, record.embeddingDimensions)

    // No lineage recorded — first use or pre-lineage record
    if (!record.embeddingProvider) {
        return { ...dimCheck, providerChanged: false }
    }

    const providerChanged = record.embeddingProvider !== currentProvider
    if (providerChanged && dimCheck.compatible) {
        // Same dimensions but different provider — vectors are in different spaces
        return {
            compatible: true, // dimensions match, but warn
            currentDimensions,
            recordDimensions: record.embeddingDimensions ?? null,
            message: `Warning: embedding provider changed from ${record.embeddingProvider} to ${currentProvider}. Vectors may be in different semantic spaces even though dimensions match (${currentDimensions}). Consider re-embedding for best accuracy.`,
            providerChanged: true,
        }
    }

    return { ...dimCheck, providerChanged }
}

// Re-export for convenience
export { HashEmbeddingAdapter, GatewayEmbeddingAdapter } from './adapters.js'
export type { EmbeddingAdapter } from './adapters.js'
export { XenovaEmbeddingAdapter, assertDefaultEmbedderDimensions } from './xenova-adapter.js'
