// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Capability discovery for provider instances.
 *
 * Discovers what each configured provider can do (chat, embeddings,
 * which models) by probing endpoints. Results are cached in the
 * provider_instances.capabilities JSONB column.
 */

import pino from 'pino'
import { db, eq } from '@plexo/db'
import { providerInstances } from '@plexo/db'
import { EMBEDDING_CAPABLE_PROVIDERS, DEFAULT_EMBEDDING_MODELS } from '../embeddings/adapters.js'
import { OllamaAdapter } from '../ollama/adapter.js'
import { decrypt } from '../connections/crypto-util.js'

const logger = pino({ name: 'provider:discovery' })

export interface ProviderCapabilities {
    supportsChat: boolean
    supportsEmbeddings: boolean
    chatModels: string[]
    embeddingModels: string[]
    discoveryError: string | null
}

/**
 * Known cloud provider capabilities (static — no discovery needed).
 */
const CLOUD_CAPABILITIES: Record<string, Omit<ProviderCapabilities, 'discoveryError'>> = {
    anthropic: { supportsChat: true, supportsEmbeddings: false, chatModels: ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5'], embeddingModels: [] },
    openai: { supportsChat: true, supportsEmbeddings: true, chatModels: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'], embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'] },
    google: { supportsChat: true, supportsEmbeddings: true, chatModels: ['gemini-2.5-flash', 'gemini-2.5-pro'], embeddingModels: ['text-embedding-004'] },
    openrouter: { supportsChat: true, supportsEmbeddings: true, chatModels: [], embeddingModels: ['openai/text-embedding-3-small'] },
    deepseek: { supportsChat: true, supportsEmbeddings: false, chatModels: ['deepseek-chat', 'deepseek-reasoner'], embeddingModels: [] },
    groq: { supportsChat: true, supportsEmbeddings: false, chatModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'], embeddingModels: [] },
    cerebras: { supportsChat: true, supportsEmbeddings: false, chatModels: ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507', 'gpt-oss-120b', 'zai-glm-4.7'], embeddingModels: [] },
    sambanova: { supportsChat: true, supportsEmbeddings: false, chatModels: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct'], embeddingModels: [] },
    fireworks: { supportsChat: true, supportsEmbeddings: true, chatModels: ['accounts/fireworks/models/llama-v3p3-70b-instruct'], embeddingModels: ['nomic-ai/nomic-embed-text-v1.5'] },
    together: { supportsChat: true, supportsEmbeddings: true, chatModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'], embeddingModels: ['togethercomputer/m2-bert-80M-8k-retrieval'] },
    mistral: { supportsChat: true, supportsEmbeddings: true, chatModels: ['mistral-large-latest', 'mistral-small-latest'], embeddingModels: ['mistral-embed'] },
    cohere: { supportsChat: true, supportsEmbeddings: true, chatModels: ['command-a-03-2025', 'command-r-plus', 'command-r'], embeddingModels: ['embed-english-v3.0'] },
    perplexity: { supportsChat: true, supportsEmbeddings: false, chatModels: ['sonar', 'sonar-pro'], embeddingModels: [] },
    xai: { supportsChat: true, supportsEmbeddings: false, chatModels: ['grok-3', 'grok-3-mini'], embeddingModels: [] },
    cloudflare: { supportsChat: true, supportsEmbeddings: true, chatModels: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'], embeddingModels: ['@cf/baai/bge-base-en-v1.5'] },
    voyage: { supportsChat: false, supportsEmbeddings: true, chatModels: [], embeddingModels: ['voyage-3'] },
    fal: { supportsChat: false, supportsEmbeddings: false, chatModels: [], embeddingModels: [] },
}

/**
 * Discover capabilities for a provider instance.
 */
export async function discoverCapabilities(instance: {
    providerType: string
    endpointUrl: string | null
    encryptedKey: string | null
    workspaceId?: string
}): Promise<ProviderCapabilities> {
    const { providerType, endpointUrl } = instance

    // Ollama: dynamic discovery via /api/tags
    if (providerType === 'ollama' || providerType === 'ollama_cloud') {
        // Ollama Cloud is a hosted service — default to ollama.com when no
        // endpoint URL is explicitly configured.
        const resolvedEndpoint = endpointUrl || (providerType === 'ollama_cloud' ? 'https://ollama.com' : null)
        if (!resolvedEndpoint) {
            return { supportsChat: false, supportsEmbeddings: false, chatModels: [], embeddingModels: [], discoveryError: 'No endpoint URL configured' }
        }

        // Decrypt API key for authenticated discovery (Ollama Cloud requires it)
        let auth: string | null = null
        if (instance.encryptedKey && instance.workspaceId) {
            try {
                auth = decrypt(instance.encryptedKey, instance.workspaceId)
            } catch (err) {
                logger.warn({ err, provider: providerType }, 'Failed to decrypt API key for discovery')
            }
        }

        try {
            const adapter = new OllamaAdapter({ id: `discovery-${providerType}`, endpoint: resolvedEndpoint, auth })
            const caps = await adapter.discoverCapabilities()
            return {
                supportsChat: caps.supportsChat,
                supportsEmbeddings: caps.supportsEmbeddings,
                chatModels: caps.chatModels,
                embeddingModels: caps.embeddingModels,
                discoveryError: null,
            }
        } catch (err) {
            return {
                supportsChat: false,
                supportsEmbeddings: false,
                chatModels: [],
                embeddingModels: [],
                discoveryError: err instanceof Error ? err.message : 'Discovery failed',
            }
        }
    }

    // Cloud providers: static capabilities
    const known = CLOUD_CAPABILITIES[providerType]
    if (known) {
        return { ...known, discoveryError: null }
    }

    // Custom providers: assume chat, check embedding capability by type
    const supportsEmbeddings = EMBEDDING_CAPABLE_PROVIDERS.has(providerType)
    const defaults = DEFAULT_EMBEDDING_MODELS[providerType]
    return {
        supportsChat: true,
        supportsEmbeddings,
        chatModels: [],
        embeddingModels: supportsEmbeddings && defaults ? [defaults.model] : [],
        discoveryError: null,
    }
}

/**
 * Refresh capabilities for a single provider instance and update the DB.
 */
export async function refreshInstanceCapabilities(instanceId: string): Promise<ProviderCapabilities> {
    const [row] = await db.select().from(providerInstances).where(eq(providerInstances.id, instanceId)).limit(1)
    if (!row) throw new Error(`Provider instance ${instanceId} not found`)

    const caps = await discoverCapabilities({
        providerType: row.providerType,
        endpointUrl: row.endpointUrl,
        encryptedKey: row.encryptedKey,
        workspaceId: row.workspaceId,
    })

    await db.update(providerInstances)
        .set({
            capabilities: caps,
            lastDiscoveredAt: new Date(),
            updatedAt: new Date(),
        })
        .where(eq(providerInstances.id, instanceId))

    return caps
}

/**
 * Refresh capabilities for all provider instances in a workspace.
 */
export async function refreshWorkspaceCapabilities(workspaceId: string): Promise<void> {
    const instances = await db.select()
        .from(providerInstances)
        .where(eq(providerInstances.workspaceId, workspaceId))

    for (const inst of instances) {
        try {
            await refreshInstanceCapabilities(inst.id)
        } catch (err) {
            logger.warn({ err, instanceId: inst.id, provider: inst.providerType }, 'Capability refresh failed for instance')
        }
    }
}
