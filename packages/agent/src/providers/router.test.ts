// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IntelligentRouter, RouterConfig, VaultConfig } from './router.js'
import { setModelCatalogStore } from './router.js'
import type { ModelCatalogStore, ModelCandidate } from '../model-knowledge.ports.js'

/**
 * Stage 3b: the router reads `models_knowledge` through `ModelCatalogStore`, so
 * this is an in-memory catalog instead of the ~65 lines of chainable `db`
 * stub + `sql` tagged-template capture + `drizzle-orm` re-export mock this
 * file used to carry. `findByStrengths` implements the same containment the
 * `@>` query does: EVERY required strength must be present.
 */
const CATALOG: ModelCandidate[] = [
    { provider: 'anthropic', modelId: 'claude-3-5-sonnet', strengths: ['reasoning', 'coding'], costPerMIn: 3000, costPerMOut: 15000 },
    { provider: 'groq', modelId: 'llama-3.1-8b-instant', strengths: ['speed', 'open-source'], costPerMIn: 50, costPerMOut: 50 },
    { provider: 'openai', modelId: 'gpt-4o-mini', strengths: ['speed', 'reasoning'], costPerMIn: 150, costPerMOut: 600 },
]

const byCost = (a: ModelCandidate, b: ModelCandidate) => a.costPerMIn - b.costPerMIn

const fakeCatalog: ModelCatalogStore = {
    async findByStrengths(requiredStrengths, limit) {
        return CATALOG
            .filter(m => requiredStrengths.every(s => m.strengths.includes(s)))
            .sort(byCost)
            .slice(0, limit)
    },
    async listCheapest(limit) {
        return [...CATALOG].sort(byCost).slice(0, limit)
    },
}

beforeEach(() => {
    setModelCatalogStore(fakeCatalog)
    // The proxy case sets this and the old suite never cleared it, so every
    // later test ran with an OpenRouter key in scope — which makes EVERY
    // provider pass the router's "has credentials" filter regardless of the
    // vault. Cleared per test; the proxy case sets it for itself.
    delete process.env.OPENROUTER_API_KEY
})

afterEach(() => {
    delete process.env.OPENROUTER_API_KEY
})

vi.mock('./registry.js', async (importOriginal) => {
    const actual = await importOriginal() as any
    return {
        ...actual,
        buildModel: vi.fn((provider, config, taskType) => ({
            _tag: 'MockModel',
            provider,
            config,
            taskType
        }))
    }
})

describe('IntelligentRouter', () => {
    
    it('Mode 4: OVERRIDE should bypass auto and BYOK, explicitly choosing the selected model', async () => {
        const vault: VaultConfig = { anthropic: { apiKey: 'sk-ant-123' } }
        const config: RouterConfig = {
            inferenceMode: 'override',
            modelOverrides: {
                verification: 'claude-3-5-haiku'
            }
        }
        
        const router = new IntelligentRouter(vault, config)
        const { meta } = await router.route('verification')
        
        expect(meta.mode).toBe('override')
        expect(meta.id).toBe('claude-3-5-haiku')
        expect(meta.provider).toBe('anthropic')
    })
    
    it('Mode 3: PROXY should route to openrouter with default task model', async () => {
        const vault: VaultConfig = {}
        const config: RouterConfig = { inferenceMode: 'proxy' }
        process.env.OPENROUTER_API_KEY = 'sk-or-proxy'
        
        const router = new IntelligentRouter(vault, config)
        const { meta } = await router.route('planning')
        
        expect(meta.mode).toBe('proxy')
        expect(meta.provider).toBe('openrouter')
    })

    it('Mode 2: BYOK should select the configured personal fallback', async () => {
        const vault: VaultConfig = { 
            openai: { apiKey: 'sk-proj-123' },
            anthropic: { apiKey: 'sk-ant-123' }
        }
        const config: RouterConfig = { 
            inferenceMode: 'byok',
            primaryProvider: 'openai',
            providers: {
                openai: { selectedModel: 'gpt-4o' }
            }
        }
        
        const router = new IntelligentRouter(vault, config)
        const { meta } = await router.route('summarization')
        
        expect(meta.mode).toBe('byok')
        expect(meta.id).toBe('gpt-4o')
        expect(meta.provider).toBe('openai')
    })

    it('Mode 1: AUTO picks the cheapest model that has the strengths AND usable credentials', async () => {
        const vault: VaultConfig = {
            groq: { apiKey: 'gsk_123' },
            anthropic: { apiKey: 'sk_ant_123' }
        }
        const config: RouterConfig = { inferenceMode: 'auto' }
        
        const router = new IntelligentRouter(vault, config)
        
        // Complex task requires 'reasoning'. The catalog has two reasoning
        // models — openai/gpt-4o-mini is cheaper, but this vault holds no
        // OpenAI key and no OpenRouter key, so anthropic is the cheapest
        // USABLE one.
        const { meta: metaComplex } = await router.route('codeGeneration')
        expect(metaComplex.mode).toBe('auto')
        expect(metaComplex.provider).toBe('anthropic')

        // Simple task requires 'speed'. groq is both usable and the cheapest.
        const { meta: metaSimple } = await router.route('summarization')
        expect(metaSimple.mode).toBe('auto')
        expect(metaSimple.provider).toBe('groq')
    })

    it('Mode 1: AUTO prefers the cheaper of two usable models with the same strength', async () => {
        // The old `db` stub returned rows in declaration order and never
        // applied the query's ORDER BY, so cost ordering was invisible to this
        // suite. With the catalog behind a port the fake sorts like the query
        // does, and this is the case that proves it: both providers have
        // 'reasoning' and both have keys, so only price decides.
        const vault: VaultConfig = {
            anthropic: { apiKey: 'sk-ant-123' },
            openai: { apiKey: 'sk-proj-123' },
        }
        const router = new IntelligentRouter(vault, { inferenceMode: 'auto' })

        const { meta } = await router.route('codeGeneration')

        expect(meta.provider).toBe('openai')
        expect(meta.id).toBe('gpt-4o-mini')
    })
})
