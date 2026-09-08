// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stage 3 — settings assembly through `WorkspaceSettingsStore`.
 *
 * This is the canonical routing path: every inference call resolves its
 * provider through it, and before the port none of it could run without a live
 * Postgres. These pin the rules that decide what routing sees:
 *   1. disabled and balance-exhausted instances are skipped entirely
 *   2. the first surviving row is primary, and the chain excludes it
 *   3. a second instance of an already-claimed type with its own endpoint gets
 *      an instance-scoped `custom_*` key instead of collapsing into one slot
 *   4. a keyless, URL-less duplicate does not clobber a configured one
 *   5. the pinned judge model is applied, and a read failure is survivable
 *   6. no instances at all means "not migrated", not an empty settings object
 *
 * The cache is disabled (`PLEXO_SETTINGS_CACHE_TTL_MS=0`) so each case reads
 * the store it was given.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
    WorkspaceSettingsStore,
    SettingsInstanceRow,
    BalanceExhaustedRow,
    JudgeModelSelection,
} from '../../workspace-settings.ports.js'

process.env.PLEXO_SETTINGS_CACHE_TTL_MS = '0'

const {
    loadSettingsFromInstances,
    listBalanceExhaustedProviders,
    markProviderBalanceExhausted,
    setWorkspaceSettingsStore,
} = await import('../settings-from-instances.js')

function instance(over: Partial<SettingsInstanceRow> = {}): SettingsInstanceRow {
    return {
        id: '11111111-2222-3333-4444-555555555555',
        nickname: 'Primary',
        providerType: 'deepseek',
        endpointUrl: null,
        encryptedKey: null,
        capabilities: { supportsChat: true, supportsEmbeddings: false, chatModels: [], embeddingModels: [], discoveryError: null },
        managed: false,
        enabled: true,
        selectedModel: null,
        balanceExhaustedAt: null,
        ...over,
    }
}

class FakeSettingsStore implements WorkspaceSettingsStore {
    judge: JudgeModelSelection | null = null
    judgeRejects: Error | null = null
    exhausted: BalanceExhaustedRow[] = []
    marked: { providerType: string; at: Date }[] = []
    markResult = 0
    cleared: string[] = []

    constructor(private instances: SettingsInstanceRow[] = []) {}

    async listInstances(): Promise<SettingsInstanceRow[]> {
        return this.instances
    }

    async getJudgeModel(): Promise<JudgeModelSelection | null> {
        if (this.judgeRejects) throw this.judgeRejects
        return this.judge
    }

    async markBalanceExhausted(_ws: string, providerType: string, at: Date): Promise<number> {
        this.marked.push({ providerType, at })
        return this.markResult
    }

    async clearBalanceExhausted(_ws: string, providerType: string): Promise<void> {
        this.cleared.push(providerType)
    }

    async listBalanceExhausted(): Promise<BalanceExhaustedRow[]> {
        return this.exhausted
    }
}

let store: FakeSettingsStore

function useStore(instances: SettingsInstanceRow[] = []): FakeSettingsStore {
    store = new FakeSettingsStore(instances)
    setWorkspaceSettingsStore(store)
    return store
}

beforeEach(() => {
    useStore([])
})

describe('loadSettingsFromInstances', () => {
    it('returns null when the workspace has no instances', async () => {
        useStore([])
        expect(await loadSettingsFromInstances('ws-1')).toBeNull()
    })

    it('returns null when every instance is skipped', async () => {
        useStore([
            instance({ providerType: 'deepseek', enabled: false }),
            instance({ providerType: 'groq', balanceExhaustedAt: new Date() }),
        ])
        expect(await loadSettingsFromInstances('ws-1')).toBeNull()
    })

    it('makes the first surviving row primary and keeps it out of the chain', async () => {
        useStore([
            instance({ providerType: 'anthropic', enabled: false }),
            instance({ providerType: 'deepseek' }),
            instance({ providerType: 'groq' }),
        ])

        const settings = await loadSettingsFromInstances('ws-1')

        expect(settings!.primaryProvider).toBe('deepseek')
        expect(settings!.fallbackChain).toEqual(['groq'])
        expect(Object.keys(settings!.providers)).toEqual(['deepseek', 'groq'])
    })

    it('drops a balance-exhausted provider from the chain entirely', async () => {
        useStore([
            instance({ providerType: 'deepseek' }),
            instance({ providerType: 'groq', balanceExhaustedAt: new Date() }),
        ])

        const settings = await loadSettingsFromInstances('ws-1')

        expect(settings!.fallbackChain).toEqual([])
        expect(settings!.providers.groq).toBeUndefined()
    })

    it('gives a second endpoint of the same type its own instance-scoped key', async () => {
        useStore([
            instance({ id: 'aaaaaaaa-0000-0000-0000-000000000000', providerType: 'ollama', endpointUrl: 'http://host-a:11434' }),
            instance({ id: 'bbbbbbbb-0000-0000-0000-000000000000', providerType: 'ollama', endpointUrl: 'http://host-b:11434', nickname: 'Second box', selectedModel: 'qwen3' }),
        ])

        const settings = (await loadSettingsFromInstances('ws-1'))!

        expect(settings.primaryProvider).toBe('ollama')
        expect(settings.fallbackChain).toEqual(['custom_ollama_bbbbbbbb'])
        const second = settings.providers['custom_ollama_bbbbbbbb' as keyof typeof settings.providers]!
        expect(second.baseUrl).toBe('http://host-b:11434')
        expect(second.displayName).toBe('Second box')
        // Never fall through to the default Claude id.
        expect(second.model).toBe('qwen3')
    })

    it('does not let a keyless, URL-less duplicate clobber a configured one', async () => {
        // What the guard actually protects is the discovered capabilities and
        // the selected model: `baseUrl` and `apiKey` would survive anyway via
        // the `?? existing` fallback in the overwrite branch, so asserting
        // those would pass with the guard deleted.
        useStore([
            instance({
                providerType: 'ollama',
                endpointUrl: 'http://user-box:11434',
                selectedModel: 'llama3',
                capabilities: { supportsChat: true, supportsEmbeddings: true, chatModels: ['llama3', 'qwen3'], embeddingModels: ['nomic'], discoveryError: null },
            }),
            instance({
                providerType: 'ollama',
                endpointUrl: null,
                nickname: 'Built-in',
                selectedModel: null,
                capabilities: { supportsChat: false, supportsEmbeddings: false, chatModels: [], embeddingModels: [], discoveryError: 'No endpoint URL configured' },
            }),
        ])

        const settings = await loadSettingsFromInstances('ws-1')
        const ollama = settings!.providers.ollama! as { baseUrl?: string; model?: string; capabilities?: { chatModels?: string[]; discoveryError?: string | null } }

        expect(ollama.baseUrl).toBe('http://user-box:11434')
        expect(ollama.model).toBe('llama3')
        expect(ollama.capabilities!.chatModels).toEqual(['llama3', 'qwen3'])
        expect(ollama.capabilities!.discoveryError).toBeNull()
    })

    it('applies a pinned judge model', async () => {
        const s = useStore([instance({ providerType: 'deepseek' })])
        s.judge = { provider: 'anthropic', model: 'claude-opus-4-7' }

        const settings = await loadSettingsFromInstances('ws-1')

        expect(settings!.judgeModel).toEqual({ provider: 'anthropic', model: 'claude-opus-4-7' })
    })

    it('still returns settings when the judge-model read fails', async () => {
        const s = useStore([instance({ providerType: 'deepseek' })])
        s.judgeRejects = new Error('workspaces is down')

        const settings = await loadSettingsFromInstances('ws-1')

        expect(settings!.primaryProvider).toBe('deepseek')
        expect(settings!.judgeModel).toBeUndefined()
    })
})

describe('balance exhaustion', () => {
    it('deduplicates the notice list by provider type and drops null timestamps', async () => {
        const s = useStore([])
        const at = new Date('2026-09-01T00:00:00Z')
        s.exhausted = [
            { providerType: 'deepseek', nickname: 'DS one', exhaustedAt: at },
            { providerType: 'deepseek', nickname: 'DS two', exhaustedAt: at },
            { providerType: 'groq', nickname: 'Groq', exhaustedAt: null },
        ]

        expect(await listBalanceExhaustedProviders('ws-1')).toEqual([
            { providerType: 'deepseek', nickname: 'DS one', exhaustedAt: at },
        ])
    })

    it('never throws from the router failure path', async () => {
        const s = useStore([])
        s.markBalanceExhausted = async () => { throw new Error('update failed') }

        await expect(markProviderBalanceExhausted('ws-1', 'deepseek')).resolves.toBeUndefined()
    })

    it('marks the provider with a first-seen timestamp', async () => {
        const s = useStore([])
        s.markResult = 2

        await markProviderBalanceExhausted('ws-1', 'deepseek')

        expect(s.marked).toHaveLength(1)
        expect(s.marked[0]!.providerType).toBe('deepseek')
        expect(s.marked[0]!.at).toBeInstanceOf(Date)
    })
})
