// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stage 3 — capability discovery through `ProviderDiscoveryStore`.
 *
 * Before the port there was no way to exercise this module without a live
 * Postgres, so it had no coverage at all. These pin the behavior the port has
 * to preserve, using an in-memory double rather than a deeper mock:
 *   1. a missing instance is an error, not a silent no-op
 *   2. a discovered result is written back to the instance it came from
 *   3. one instance's failure does not abort a workspace refresh
 *   4. no key + no endpoint means no network call is attempted
 *
 * Only providers on the static cloud table are used, so nothing here probes a
 * real endpoint.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
    refreshInstanceCapabilities,
    refreshWorkspaceCapabilities,
    setProviderDiscoveryStore,
} from '../discovery.js'
import type {
    ProviderDiscoveryStore,
    DiscoveryInstance,
    ProviderCapabilities,
} from '../../provider-discovery.ports.js'

interface Saved { capabilities: ProviderCapabilities; discoveredAt: Date }

class FakeDiscoveryStore implements ProviderDiscoveryStore {
    readonly saves = new Map<string, Saved>()
    saveCalls = 0

    constructor(private readonly instances: DiscoveryInstance[]) {}

    async getInstance(instanceId: string): Promise<DiscoveryInstance | null> {
        return this.instances.find(i => i.id === instanceId) ?? null
    }

    async listWorkspaceInstances(workspaceId: string): Promise<DiscoveryInstance[]> {
        return this.instances.filter(i => i.workspaceId === workspaceId)
    }

    async saveCapabilities(instanceId: string, capabilities: ProviderCapabilities, discoveredAt: Date): Promise<void> {
        this.saveCalls += 1
        this.saves.set(instanceId, { capabilities, discoveredAt })
    }
}

function instance(over: Partial<DiscoveryInstance> = {}): DiscoveryInstance {
    return {
        id: 'inst-1',
        workspaceId: 'ws-1',
        providerType: 'deepseek',
        endpointUrl: null,
        encryptedKey: null,
        managed: false,
        ...over,
    }
}

let store: FakeDiscoveryStore

function useStore(instances: DiscoveryInstance[]): FakeDiscoveryStore {
    store = new FakeDiscoveryStore(instances)
    setProviderDiscoveryStore(store)
    return store
}

beforeEach(() => {
    useStore([])
})

describe('refreshInstanceCapabilities', () => {
    it('throws when the instance does not exist', async () => {
        useStore([])
        await expect(refreshInstanceCapabilities('missing')).rejects.toThrow('Provider instance missing not found')
    })

    it('writes the discovered capabilities back to that instance', async () => {
        const s = useStore([instance({ id: 'inst-ds', providerType: 'deepseek' })])

        const caps = await refreshInstanceCapabilities('inst-ds')

        expect(caps.supportsChat).toBe(true)
        expect(caps.supportsEmbeddings).toBe(false)
        expect(caps.chatModels).toContain('deepseek-chat')
        expect(caps.discoveryError).toBeNull()
        expect(s.saveCalls).toBe(1)
        expect(s.saves.get('inst-ds')!.capabilities).toEqual(caps)
        expect(s.saves.get('inst-ds')!.discoveredAt).toBeInstanceOf(Date)
    })

    it('reports a discovery error instead of throwing when an ollama row has no endpoint', async () => {
        const s = useStore([instance({ id: 'inst-ol', providerType: 'ollama', endpointUrl: null, managed: false })])

        const caps = await refreshInstanceCapabilities('inst-ol')

        expect(caps.discoveryError).toBe('No endpoint URL configured')
        expect(caps.supportsChat).toBe(false)
        expect(s.saves.get('inst-ol')!.capabilities.discoveryError).toBe('No endpoint URL configured')
    })
})

describe('refreshWorkspaceCapabilities', () => {
    it('refreshes every instance in the workspace and skips other workspaces', async () => {
        const s = useStore([
            instance({ id: 'a', workspaceId: 'ws-1', providerType: 'deepseek' }),
            instance({ id: 'b', workspaceId: 'ws-1', providerType: 'anthropic' }),
            instance({ id: 'c', workspaceId: 'ws-2', providerType: 'deepseek' }),
        ])

        await refreshWorkspaceCapabilities('ws-1')

        expect([...s.saves.keys()].sort()).toEqual(['a', 'b'])
        expect(s.saves.get('b')!.capabilities.chatModels).toContain('claude-haiku-4-5')
    })

    it('keeps going when one instance fails', async () => {
        const s = useStore([
            instance({ id: 'ok-1', workspaceId: 'ws-1' }),
            instance({ id: 'ok-2', workspaceId: 'ws-1' }),
        ])
        // The row is listed for the workspace but cannot be fetched by id — the
        // same shape as a delete landing between the list and the refresh.
        s.getInstance = async (id: string) => (id === 'ok-1' ? null : instance({ id, workspaceId: 'ws-1' }))

        await expect(refreshWorkspaceCapabilities('ws-1')).resolves.toBeUndefined()

        expect([...s.saves.keys()]).toEqual(['ok-2'])
    })
})
