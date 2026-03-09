// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi } from 'vitest'
import { IntelligentRouter, RouterConfig, VaultConfig } from './router.js'
import { db } from '@plexo/db'

// Mocks
vi.mock('@plexo/db', () => ({
    db: {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
            { provider: 'anthropic', modelId: 'claude-3-5-sonnet', strengths: ['reasoning', 'coding'], costPerMIn: 3000, costPerMOut: 15000 },
            { provider: 'groq', modelId: 'llama-3.1-8b-instant', strengths: ['speed', 'open-source'], costPerMIn: 50, costPerMOut: 50 },
            { provider: 'openai', modelId: 'gpt-4o-mini', strengths: ['speed', 'reasoning'], costPerMIn: 150, costPerMOut: 600 }
        ])
    },
    sql: vi.fn(),
    modelsKnowledge: {}
}))

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

    it('Mode 1: AUTO should arbitrate capabilities logically using db strengths', async () => {
        const vault: VaultConfig = {
            groq: { apiKey: 'gsk_123' },
            anthropic: { apiKey: 'sk_ant_123' }
        }
        const config: RouterConfig = { inferenceMode: 'auto' }
        
        const router = new IntelligentRouter(vault, config)
        
        // Complex task requiring 'reasoning'
        const { meta: metaComplex } = await router.route('codeGeneration')
        expect(metaComplex.mode).toBe('auto')
        // anthropic has reasoning and groq does not in our mock
        expect(metaComplex.provider).toBe('anthropic')
        
        // Simple task requires 'speed'
        const { meta: metaSimple } = await router.route('summarization')
        expect(metaSimple.mode).toBe('auto')
        // groq has speed in our mock, should be chosen
        expect(metaSimple.provider).toBe('groq')
    })
})
