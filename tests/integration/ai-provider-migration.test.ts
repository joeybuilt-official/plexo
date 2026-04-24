// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDecoupledSettings } from '../../apps/api/src/routes/ai-provider-creds.js'

vi.mock('../../apps/api/src/routes/introspect.js', () => ({
    invalidateIntrospectCache: vi.fn(),
}))

vi.mock('../../apps/api/src/crypto.js', () => ({
    encrypt: vi.fn((val) => val),
    decrypt: vi.fn((val) => val),
}))

vi.mock('../../apps/api/src/logger.js', () => ({
    logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    }
}))

// Mock db to prevent actual db updates during getDecoupledSettings legacy migration
vi.mock('@plexo/db', async (importOriginal) => {
    const actual = await importOriginal() as any
    return {
        ...actual,
        db: {
            update: vi.fn().mockReturnThis(),
            set: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([]),
        },
    }
})

describe('AI Provider Migration', () => {
    const workspaceId = '00000000-0000-0000-0000-000000000001'

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should map legacy aiProviders into separate vault and arbiter', () => {
        // Legacy aiProviders shape with encrypted keys simulating existing data
        const legacySettings = {
            aiProviders: {
                inferenceMode: 'byok',
                primaryProvider: 'openai',
                fallbackChain: ['anthropic', 'google'],
                providers: {
                    openai: {
                        apiKey: 'ivxyz.ctxxyz.tagxyz',
                        selectedModel: 'gpt-4o',
                        enabled: true
                    },
                    anthropic: {
                        apiKey: 'ivabc.ctabc.tagabc',
                        selectedModel: 'claude-3-5-sonnet',
                        enabled: false
                    }
                }
            }
        }

        const result = getDecoupledSettings(workspaceId, legacySettings as any)
        
        // Assert migration status
        expect(result.migrated).toBe(true)

        // Assert vault decoupled correctly containing sensitive keys
        expect(result.vault.openai).toBeDefined()
        expect(result.vault.openai?.apiKey).toBe('ivxyz.ctxxyz.tagxyz')
        expect(result.vault.anthropic?.apiKey).toBe('ivabc.ctabc.tagabc')
        
        // Assert arbiter decoupled correctly containing routing rules
        expect(result.arbiter.inferenceMode).toBe('byok')
        expect(result.arbiter.primaryProvider).toBe('openai')
        expect(result.arbiter.fallbackChain).toEqual(['anthropic', 'google'])
        
        expect(result.arbiter.providers?.openai).toBeDefined()
        expect(result.arbiter.providers?.openai?.selectedModel).toBe('gpt-4o')
        expect(result.arbiter.providers?.openai?.enabled).toBe(true)
        // Ensure sensitive info didn't bleed into arbiter
        expect((result.arbiter.providers?.openai as any).apiKey).toBeUndefined()
    })

    it('should pass through already migrated settings untouched', () => {
        const migratedSettings = {
            vault: {
                groq: { apiKey: 'gsk_enc123' }
            },
            arbiter: {
                inferenceMode: 'auto',
                primaryProvider: 'groq',
                providers: {
                    groq: { enabled: true, selectedModel: 'llama-3.1-8b-instant' }
                }
            }
        }

        const result = getDecoupledSettings(workspaceId, migratedSettings as any)
        expect(result.migrated).toBe(false)
        expect(result.vault.groq?.apiKey).toBe('gsk_enc123')
        expect(result.arbiter.inferenceMode).toBe('auto')
        expect(result.arbiter.primaryProvider).toBe('groq')
    })
})
