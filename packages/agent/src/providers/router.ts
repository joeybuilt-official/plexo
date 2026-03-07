import { AnyLanguageModel, TaskType, ProviderKey, DEFAULT_MODEL_ROUTING } from './registry.js'
import { db, sql } from '@plexo/db'
import { modelsKnowledge } from '@plexo/db'
import { buildModel } from './registry.js'

export type InferenceMode = 'auto' | 'byok' | 'proxy' | 'override'

export interface VaultConfig {
    [provider: string]: {
        apiKey?: string
        oauthToken?: string
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
        // Requires special proxy keys or auth injection which is handled outside in the API call.
        // For now, route directly using OPENROUTER_API_KEY as the proxy key.
        const provider: ProviderKey = 'openrouter'
        const defaultModel = DEFAULT_MODEL_ROUTING[taskType]
        
        return {
            model: buildModel(provider, { provider, apiKey: process.env.OPENROUTER_API_KEY }, taskType, {
                primaryProvider: provider,
                fallbackChain: [],
                providers: { [provider]: { model: defaultModel } }
            } as any),
            meta: {
                id: defaultModel,
                provider,
                mode: 'proxy' as InferenceMode,
                costPerMIn: 0, // Costs would be managed on proxy side
                costPerMOut: 0
            } as ResolvedModelMeta
        }
    }

    private async handleAuto(taskType: TaskType) {
        // Mode 1: Auto cost vs quality arbitration.
        // Queries `models_knowledge` to find the cheapest model meeting strength criteria.
        
        // Let's require 'reasoning' for complex tasks, 'speed' for others.
        const requiredStrengths = ['planning', 'codeGeneration', 'verification'].includes(taskType) 
            ? ['reasoning'] : ['speed']

        const models = await db.select()
            .from(modelsKnowledge)
            // .where(sql`${requiredStrengths[0]} = ANY(${modelsKnowledge.strengths})`)
            .orderBy(modelsKnowledge.costPerMIn) // Cheapest first
            .limit(10)
        
        // Filter by available keys in BYOK combined with proxy availability
        const usableModels = models.filter(m => {
            if (this.vault[m.provider]?.apiKey) return true
            if (process.env.OPENROUTER_API_KEY) return true // available universally
            return false
        })

        const best = usableModels.find(m => m.strengths.some(s => requiredStrengths.includes(s))) || models[0]
        if (!best) {
            return this.handleByok(taskType) // absolute fallback
        }

        const provider = best.provider as ProviderKey
        const creds = this.vault[provider] || {}
        const apiKey = creds.apiKey || process.env.OPENROUTER_API_KEY // generic fallback
        
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

    private async handleByok(taskType: TaskType) {
        // Mode 2: Standard user-configured fallback chains
        const provider = this.config.primaryProvider ?? 'anthropic'
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
