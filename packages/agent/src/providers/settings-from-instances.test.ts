import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DB
const mockRows: any[] = []
let dbLoads = 0
vi.mock('@plexo/db', () => ({
    db: {
        select: () => ({
            from: () => ({
                where: () => ({
                    orderBy: () => { dbLoads++; return Promise.resolve(mockRows) },
                }),
            }),
        }),
    },
    eq: (a: any, b: any) => [a, b],
    asc: (a: any) => a,
    providerInstances: { workspaceId: 'workspace_id', preferenceOrder: 'preference_order' },
}))

import { loadSettingsFromInstances, invalidateSettingsCache } from './settings-from-instances.js'

describe('loadSettingsFromInstances', () => {
    beforeEach(() => { mockRows.length = 0; dbLoads = 0; invalidateSettingsCache() })

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

    it('gives a second same-type instance with its own endpoint an instance-scoped chain entry', async () => {
        mockRows.push(
            { id: 'aaaa1111-0000-4000-9000-000000000001', providerType: 'ollama', enabled: true, encryptedKey: null, endpointUrl: 'http://ollama:11434', managed: true, selectedModel: 'gemma3:4b', preferenceOrder: 0 },
            { id: 'bbbb2222-0000-4000-9000-000000000002', providerType: 'deepseek', enabled: true, encryptedKey: null, endpointUrl: null, managed: false, selectedModel: 'deepseek-chat', preferenceOrder: 1 },
            { id: 'cccc3333-0000-4000-9000-000000000003', providerType: 'ollama', enabled: true, encryptedKey: null, endpointUrl: 'http://100.64.0.1:11434', managed: false, selectedModel: null, preferenceOrder: 2, capabilities: { chatModels: ['qwen3:32b'] } },
        )

        const result = await loadSettingsFromInstances('ws-multi')
        expect(result!.primaryProvider).toBe('ollama')
        const instanceKey = 'custom_ollama_cccc3333'
        expect(result!.fallbackChain).toEqual(['deepseek', instanceKey])
        // Both servers keep their own endpoint + model — neither collapses into the other.
        expect(result!.providers.ollama?.baseUrl).toBe('http://ollama:11434')
        expect((result!.providers as any)[instanceKey]?.baseUrl).toBe('http://100.64.0.1:11434')
        // Model pinned to the instance's first discovered chat model, never a
        // DEFAULT_MODEL_ROUTING (Claude) id.
        expect((result!.providers as any)[instanceKey]?.model).toBe('qwen3:32b')
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

    describe('short-TTL cache (Round-4 Phase 6)', () => {
        it('memoizes within TTL — second call does not re-hit the DB', async () => {
            mockRows.push({ id: '1', providerType: 'anthropic', enabled: true, encryptedKey: null, endpointUrl: null, managed: false, selectedModel: 'm1', preferenceOrder: 0 })

            const a = await loadSettingsFromInstances('ws-cache')
            expect(a!.primaryProvider).toBe('anthropic')
            expect(dbLoads).toBe(1)

            // Mutate the underlying rows; cached value must be returned unchanged.
            mockRows.length = 0
            mockRows.push({ id: '2', providerType: 'openai', enabled: true, encryptedKey: null, endpointUrl: null, managed: false, selectedModel: 'm2', preferenceOrder: 0 })

            const b = await loadSettingsFromInstances('ws-cache')
            expect(b!.primaryProvider).toBe('anthropic') // stale-but-cached
            expect(dbLoads).toBe(1) // no second DB load
        })

        it('invalidateSettingsCache(ws) forces a reload for that workspace only', async () => {
            mockRows.push({ id: '1', providerType: 'anthropic', enabled: true, encryptedKey: null, endpointUrl: null, managed: false, selectedModel: 'm1', preferenceOrder: 0 })
            await loadSettingsFromInstances('ws-a')
            await loadSettingsFromInstances('ws-b')
            expect(dbLoads).toBe(2)

            invalidateSettingsCache('ws-a')

            mockRows.length = 0
            mockRows.push({ id: '2', providerType: 'openai', enabled: true, encryptedKey: null, endpointUrl: null, managed: false, selectedModel: 'm2', preferenceOrder: 0 })

            const a = await loadSettingsFromInstances('ws-a')
            expect(a!.primaryProvider).toBe('openai') // reloaded
            expect(dbLoads).toBe(3)

            const b = await loadSettingsFromInstances('ws-b')
            expect(b!.primaryProvider).toBe('anthropic') // still cached
            expect(dbLoads).toBe(3)
        })
    })
})
