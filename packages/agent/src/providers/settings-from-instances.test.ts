import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DB
const mockRows: any[] = []
vi.mock('@plexo/db', () => ({
    db: {
        select: () => ({
            from: () => ({
                where: () => ({
                    orderBy: () => Promise.resolve(mockRows),
                }),
            }),
        }),
    },
    eq: (a: any, b: any) => [a, b],
    asc: (a: any) => a,
    providerInstances: { workspaceId: 'workspace_id', preferenceOrder: 'preference_order' },
}))

import { loadSettingsFromInstances } from './settings-from-instances.js'

describe('loadSettingsFromInstances', () => {
    beforeEach(() => { mockRows.length = 0 })

    it('returns null for empty workspace', async () => {
        expect(await loadSettingsFromInstances('ws-1')).toBeNull()
    })

    it('builds settings from instances with correct chain order', async () => {
        mockRows.push(
            { id: '1', providerType: 'anthropic', enabled: true, encryptedKey: null, endpointUrl: null, managed: false, selectedModel: 'claude-sonnet-4-5', preferenceOrder: 0 },
            { id: '2', providerType: 'openai', enabled: true, encryptedKey: null, endpointUrl: null, managed: false, selectedModel: 'gpt-4o', preferenceOrder: 1 },
            { id: '3', providerType: 'ollama', enabled: true, encryptedKey: null, endpointUrl: null, managed: true, selectedModel: null, preferenceOrder: 2 },
        )

        const result = await loadSettingsFromInstances('ws-1')
        expect(result).not.toBeNull()
        expect(result!.primaryProvider).toBe('anthropic')
        expect(result!.fallbackChain).toEqual(['openai', 'ollama'])
        expect(result!.providers.anthropic?.model).toBe('claude-sonnet-4-5')
    })

    it('skips disabled providers', async () => {
        mockRows.push(
            { id: '1', providerType: 'anthropic', enabled: false, encryptedKey: null, endpointUrl: null, managed: false, selectedModel: null, preferenceOrder: 0 },
            { id: '2', providerType: 'openai', enabled: true, encryptedKey: null, endpointUrl: null, managed: false, selectedModel: null, preferenceOrder: 1 },
        )

        const result = await loadSettingsFromInstances('ws-1')
        expect(result!.primaryProvider).toBe('openai')
        expect(result!.fallbackChain).toEqual([])
    })

    it('resolves managed Ollama URL from env', async () => {
        process.env.OLLAMA_INTERNAL_URL = 'http://ollama:11434'
        mockRows.push(
            { id: '1', providerType: 'ollama', enabled: true, encryptedKey: null, endpointUrl: null, managed: true, selectedModel: null, preferenceOrder: 0 },
        )

        const result = await loadSettingsFromInstances('ws-1')
        expect(result!.providers.ollama?.baseUrl).toBe('http://ollama:11434')
        delete process.env.OLLAMA_INTERNAL_URL
    })
})
