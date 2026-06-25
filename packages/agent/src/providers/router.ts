// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { AnyLanguageModel, TaskType, ProviderKey, DEFAULT_MODEL_ROUTING } from './registry.js'
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { modelsKnowledge } from '@plexo/db'
import { buildModel } from './registry.js'
import { resolveChain, type ChainEntry, type ChainTaskType } from './chain-resolver.js'
import * as crypto from 'crypto'

export type InferenceMode = 'auto' | 'byok' | 'proxy' | 'override'

/**
 * Phase 2b — set of TaskType values that have a chain table entry. The
 * chain table only knows the task types that the registry exposes; this
 * set lets the router cheaply guard the chain lookup so a future task
 * type added to the registry without a chain row doesn't NPE.
 */
const CHAIN_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
    'planning',
    'codeGeneration',
    'verification',
    'summarization',
    'conversation',
    'classification',
    'logAnalysis',
    'extraction',
])

export interface VaultConfig {
    [provider: string]: {
        apiKey?: string
        baseUrl?: string
    } | undefined
}

export interface RouterConfig {
    inferenceMode?: InferenceMode
    primaryProvider?: ProviderKey
    fallbackChain?: ProviderKey[]
    providers?: Record<string, { selectedModel?: string; defaultModel?: string; enabled?: boolean }>
    modelOverrides?: Partial<Record<TaskType, string>>
}

export interface ResolvedModelMeta {
    id: string
    provider: ProviderKey
    mode: InferenceMode
    costPerMIn: number
    costPerMOut: number
}

/**
 * Intelligent LLM Router
 * Selects the optimal model and instantiates it via the vault credentials.
 */
export class IntelligentRouter {
    constructor(
        private vault: VaultConfig,
        private config: RouterConfig,
        private workspaceId?: string
    ) {}

    /**
     * Resolves and builds the executing model using dynamic arbitration.
     */
    async route(taskType: TaskType): Promise<{ model: AnyLanguageModel, meta: ResolvedModelMeta }> {
        const mode = this.config.inferenceMode ?? 'byok' // Legacy defaults to BYOK

        switch (mode) {
            case 'override':
                return this.handleOverride(taskType)
            case 'proxy':
                return this.handleProxy(taskType)
            case 'auto':
                return this.handleAuto(taskType)
            case 'byok':
            default:
                return this.handleByok(taskType)
        }
    }

    private async handleOverride(taskType: TaskType) {
        // Mode 4: Strict Override enforces the taskType override ignoring cost bounds
        const overrideModel = this.config.modelOverrides?.[taskType]
        if (!overrideModel) return this.handleByok(taskType) // Fall back to BYOK if no override set

        // Infer provider from model name naively or lookup in DB
        const provider = this.inferProvider(overrideModel)
        const creds = this.vault[provider] || {}
        
        return {
            model: buildModel(provider, { provider, apiKey: creds.apiKey, baseUrl: creds.baseUrl }, taskType, {
                primaryProvider: provider,
                fallbackChain: [],
                providers: { [provider]: { model: overrideModel } },
                modelOverrides: { [taskType]: overrideModel }
            } as any),
            meta: {
                id: overrideModel,
                provider,
                mode: 'override' as InferenceMode,
                costPerMIn: 0,
                costPerMOut: 0
            } as ResolvedModelMeta
        }
    }

    private async handleProxy(taskType: TaskType) {
        // Mode 3: Proxy execution using Plexo managed key pool.
        const provider: ProviderKey = 'openrouter'
        const defaultModel = DEFAULT_MODEL_ROUTING[taskType]
        const proxyUrl = process.env.PLEXO_PROXY_URL || 'https://proxy.plexo.ai/v1/infer'
        const proxyKey = process.env.PLEXO_API_KEY || ''
        const instanceId = process.env.PLEXO_INSTANCE_ID || '00000000-0000-0000-0000-000000000000'
        // Fail closed: never sign managed-proxy requests with a known constant.
        // A missing secret must abort the proxy path, not silently degrade to a
        // forgeable signature (arch-findings P1). The previous `|| 'dev-secret'`
        // fallback meant an unset prod env signed with a public string.
        const signingSecret = process.env.PLEXO_SIGNING_SECRET
        if (!signingSecret) {
            throw new Error('PLEXO_SIGNING_SECRET is not set — refusing to sign managed-proxy inference requests')
        }
        const workspaceId = this.workspaceId || 'system'
        
        const proxyFetch = async (url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
            const requestInit = init || {}
            let rawBody = requestInit.body as string
            
            if (rawBody && typeof rawBody === 'string') {
                const openaiPayload = JSON.parse(rawBody)
                const envelope = {
                    plexo_instance_id: instanceId,
                    plexo_task_id: 'auto-routed-task',
                    plexo_workspace_id: workspaceId,
                    task_type: taskType === 'codeGeneration' ? 'code_generation' : taskType,
                    preferred_provider: 'openrouter',
                    preferred_model: defaultModel,
                    messages: openaiPayload.messages,
                    max_tokens: openaiPayload.max_tokens || 4000,
                    temperature: openaiPayload.temperature,
                    stream: openaiPayload.stream || false,
                    tools: openaiPayload.tools,
                    tool_choice: openaiPayload.tool_choice
                }
                
                rawBody = JSON.stringify(envelope)
                requestInit.body = rawBody
                
                const timestamp = Date.now().toString()
                const signature = crypto.createHmac('sha256', signingSecret)
                    .update(timestamp)
                    .update(instanceId)
                    .update(rawBody)
                    .digest('hex')

                requestInit.headers = {
                    ...(requestInit.headers as Record<string, string>),
                    'Authorization': `Bearer ${proxyKey}`,
                    'X-Plexo-Signature': signature,
                    'X-Plexo-Timestamp': timestamp,
                    'Content-Type': 'application/json'
                }
                
                const response = await globalThis.fetch(proxyUrl, requestInit)
                if (!response.ok) return response
                
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proxy response shape is not typed
                const plexoRes = await response.json() as any
                const openaiRes = {
                    id: plexoRes.gateway_request_id,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: plexoRes.model_used,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: plexoRes.content?.[0]?.text || '',
                            tool_calls: (plexoRes.content || []).filter((c: any) => c.type === 'tool_use').map((c: any) => ({
                                id: c.tool_use?.id || '',
                                type: 'function',
                                function: c.tool_use?.function
                            }))
                        },
                        finish_reason: plexoRes.stop_reason === 'stop' ? 'stop' : (plexoRes.content?.some((c:any) => c.type === 'tool_use') ? 'tool_calls' : 'stop')
                    }],
                    usage: {
                        prompt_tokens: plexoRes.usage?.tokens_input || 0,
                        completion_tokens: plexoRes.usage?.tokens_output || 0,
                        total_tokens: (plexoRes.usage?.tokens_input || 0) + (plexoRes.usage?.tokens_output || 0)
                    }
                }
                
                return new Response(JSON.stringify(openaiRes), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                })
            }
            return globalThis.fetch(url, init)
        }
        
        return {
            model: buildModel(provider, { provider, apiKey: 'proxy-enabled', customFetch: proxyFetch as any }, taskType, {
                primaryProvider: provider,
                fallbackChain: [],
                providers: { [provider]: { model: defaultModel } }
            } as any),
            meta: {
                id: defaultModel,
                provider,
                mode: 'proxy' as InferenceMode,
                costPerMIn: 0, 
                costPerMOut: 0
            } as ResolvedModelMeta
        }
    }

    // FUN-025 — BYOK key validation should happen at save time, not first use (handled in provider-instances route)
    private async handleAuto(taskType: TaskType) {
        // Mode 1: Auto cost vs quality arbitration.
        // Queries `models_knowledge` to find the cheapest model meeting ALL strength criteria.

        const requiredStrengths = ['planning', 'codeGeneration', 'verification'].includes(taskType)
            ? ['reasoning'] : ['speed']

        // FUN-023: Use @> containment on the FULL required strengths array, not just [0]
        const models = await db.select()
            .from(modelsKnowledge)
            .where(sql`${modelsKnowledge.strengths} @> ${JSON.stringify(requiredStrengths)}::jsonb`)
            .orderBy(modelsKnowledge.costPerMIn) // Cheapest first
            .limit(10)

        // Filter to models with actual credentials configured
        const usableModels = models.filter(m => {
            if (this.vault[m.provider]?.apiKey) return true
            if (process.env.OPENROUTER_API_KEY) return true
            return false
        })

        let best = usableModels[0] // First usable model matching ALL strengths

        // FUN-023: If no model matches all strengths, fall back to best partial match
        if (!best) {
            const partialModels = await db.select()
                .from(modelsKnowledge)
                .orderBy(modelsKnowledge.costPerMIn)
                .limit(20)

            const usablePartials = partialModels.filter(m => {
                if (this.vault[m.provider]?.apiKey) return true
                if (process.env.OPENROUTER_API_KEY) return true
                return false
            })

            // Score by how many required strengths each model has
            best = usablePartials
                .map(m => ({
                    model: m,
                    matchCount: requiredStrengths.filter(s => m.strengths.includes(s)).length,
                }))
                .sort((a, b) => b.matchCount - a.matchCount || a.model.costPerMIn - b.model.costPerMIn)
                .map(x => x.model)[0]
        }

        if (!best) {
            return this.handleByok(taskType) // absolute fallback
        }

        const provider = best.provider as ProviderKey
        const creds = this.vault[provider] || {}
        const apiKey = creds.apiKey || process.env.OPENROUTER_API_KEY

        return {
            model: buildModel(provider, { provider, apiKey, baseUrl: creds.baseUrl }, taskType, {
                primaryProvider: provider,
                fallbackChain: [],
                providers: { [provider]: { model: best.modelId } }
            } as any),
            meta: {
                id: best.modelId,
                provider,
                mode: 'auto' as InferenceMode,
                costPerMIn: best.costPerMIn,
                costPerMOut: best.costPerMOut
            } as ResolvedModelMeta
        }
    }

    /**
     * Phase 2b — Walk a per-task-type chain from `routing_chains` and
     * return the first entry whose provider has usable credentials in
     * the vault. Returns `null` when no chain is configured for this
     * (workspace, taskType) so the caller falls back to the legacy
     * primary-provider path.
     */
    private async resolveChainEntry(taskType: TaskType): Promise<{ entry: ChainEntry; provider: ProviderKey } | null> {
        if (!this.workspaceId) return null
        if (!CHAIN_TASK_TYPES.has(taskType)) return null
        const chain = await resolveChain(this.workspaceId, taskType as ChainTaskType)
        if (!chain || chain.length === 0) return null
        for (const entry of chain) {
            const providerKey = (entry.providerType || this.inferProvider(entry.modelId)) as ProviderKey
            const creds = this.vault[providerKey]
            if (creds?.apiKey || providerKey === 'ollama') {
                return { entry, provider: providerKey }
            }
        }
        return null
    }

    private async handleByok(taskType: TaskType) {
        // Single-model policy: always use the workspace's primary provider for
        // all task types. Per-task routing_chains are bypassed — operators
        // configure one primary and rely on the legacy fallbackChain only
        // when the primary fails at call time. The chain-resolver / catalog
        // path (Phase 2b) is retained in the codebase but unused; see
        // adr/ for the decision context.
        const provider = this.config.primaryProvider
        if (!provider) {
            throw new Error('No AI provider configured for this workspace. Set a primary provider in Settings → AI Providers.')
        }
        const configProvider = this.config.providers?.[provider]
        const creds = this.vault[provider] || {}

        return {
            model: buildModel(provider, { provider, apiKey: creds.apiKey, baseUrl: creds.baseUrl, model: configProvider?.selectedModel }, taskType, {
                primaryProvider: provider,
                fallbackChain: this.config.fallbackChain || [],
                providers: this.config.providers || {},
                modelOverrides: this.config.modelOverrides || {}
            } as any),
            meta: {
                id: configProvider?.selectedModel || DEFAULT_MODEL_ROUTING[taskType],
                provider,
                mode: 'byok' as InferenceMode,
                costPerMIn: 0,
                costPerMOut: 0
            } as ResolvedModelMeta
        }
    }

    private inferProvider(modelId: string): ProviderKey {
        if (modelId.includes('claude')) return 'anthropic'
        if (modelId.includes('gpt') || modelId.includes('o1') || modelId.includes('o3')) return 'openai'
        if (modelId.includes('gemini')) return 'google'
        if (modelId.includes('llama') && !modelId.includes('openrouter')) return 'groq' // naive fallback
        return 'openrouter'
    }
}
