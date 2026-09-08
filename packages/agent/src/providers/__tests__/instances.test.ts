// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stage 3 — provider-instance CRUD through `ProviderInstanceStore`.
 *
 * Before the port this module could not run without a live Postgres, so the
 * Intelligence page's write path had no coverage. These pin the rules that
 * live in the use case, which is exactly what a persistence swap could break:
 *   1. a new provider goes last, including in an empty workspace
 *   2. the managed provider cannot be removed, and a refused removal deletes
 *      nothing
 *   3. a reorder ALWAYS writes `preferenceOrder` — the column the runtime
 *      reads — whichever UI section asked for it
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
    listProviders,
    getProvider,
    addProvider,
    updateProvider,
    removeProvider,
    reorderProviders,
    setProviderInstanceStore,
} from '../instances.js'
import type {
    ProviderInstanceStore,
    ProviderInstanceRow,
    ProviderInstanceInsert,
    ProviderInstanceUpdate,
    PreferenceOrderUpdate,
} from '../../provider-instances.ports.js'

function row(over: Partial<ProviderInstanceRow> = {}): ProviderInstanceRow {
    return {
        id: 'inst-1',
        workspaceId: 'ws-1',
        nickname: 'Primary',
        providerType: 'deepseek',
        endpointUrl: null,
        encryptedKey: null,
        capabilities: { supportsChat: true, supportsEmbeddings: false, chatModels: [], embeddingModels: [], discoveryError: null },
        preferenceOrder: 0,
        managed: false,
        enabled: true,
        selectedModel: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        lastDiscoveredAt: null,
        modelCompatStatus: null,
        modelCompatValidatedAt: null,
        ...over,
    }
}

class FakeInstanceStore implements ProviderInstanceStore {
    inserted: ProviderInstanceInsert[] = []
    updated: { instanceId: string; updates: ProviderInstanceUpdate }[] = []
    deleted: string[] = []
    orders: { instanceId: string; order: PreferenceOrderUpdate }[] = []
    maxOrder: number | null = null

    constructor(private rows: ProviderInstanceRow[] = []) {}

    async listByWorkspace(workspaceId: string): Promise<ProviderInstanceRow[]> {
        return this.rows
            .filter(r => r.workspaceId === workspaceId)
            .sort((a, b) => a.preferenceOrder - b.preferenceOrder)
    }

    async getById(instanceId: string): Promise<ProviderInstanceRow | null> {
        return this.rows.find(r => r.id === instanceId) ?? null
    }

    async getOwnership(instanceId: string) {
        const found = this.rows.find(r => r.id === instanceId)
        return found ? { workspaceId: found.workspaceId, managed: found.managed } : null
    }

    async maxPreferenceOrder(): Promise<number | null> {
        return this.maxOrder
    }

    async insert(input: ProviderInstanceInsert): Promise<ProviderInstanceRow> {
        this.inserted.push(input)
        return row({ id: 'inst-new', ...input })
    }

    async update(instanceId: string, updates: ProviderInstanceUpdate): Promise<ProviderInstanceRow | null> {
        this.updated.push({ instanceId, updates })
        const found = this.rows.find(r => r.id === instanceId)
        return found ? { ...found, ...updates } as ProviderInstanceRow : null
    }

    async delete(instanceId: string): Promise<void> {
        this.deleted.push(instanceId)
    }

    async setPreferenceOrder(_workspaceId: string, instanceId: string, order: PreferenceOrderUpdate): Promise<void> {
        this.orders.push({ instanceId, order })
    }
}

let store: FakeInstanceStore

function useStore(rows: ProviderInstanceRow[] = []): FakeInstanceStore {
    store = new FakeInstanceStore(rows)
    setProviderInstanceStore(store)
    return store
}

beforeEach(() => {
    useStore([])
})

describe('addProvider', () => {
    it('puts the first provider of an empty workspace at order 0', async () => {
        const s = useStore([])
        s.maxOrder = null

        await addProvider('ws-1', { nickname: 'First', providerType: 'deepseek' })

        expect(s.inserted[0]!.preferenceOrder).toBe(0)
    })

    it('puts a new provider after the current last', async () => {
        const s = useStore([])
        s.maxOrder = 3

        await addProvider('ws-1', { nickname: 'Fourth', providerType: 'deepseek' })

        expect(s.inserted[0]!.preferenceOrder).toBe(4)
    })

    it('stores the capabilities discovered for the provider type', async () => {
        const s = useStore([])

        const created = await addProvider('ws-1', { nickname: 'DS', providerType: 'deepseek' })

        expect(s.inserted[0]!.capabilities.supportsChat).toBe(true)
        expect(s.inserted[0]!.capabilities.chatModels).toContain('deepseek-chat')
        expect(s.inserted[0]!.lastDiscoveredAt).toBeInstanceOf(Date)
        expect(created.nickname).toBe('DS')
    })
})

describe('removeProvider', () => {
    it('refuses the managed provider and deletes nothing', async () => {
        const s = useStore([row({ id: 'inst-managed', managed: true })])

        await expect(removeProvider('inst-managed')).rejects.toThrow('Cannot remove the managed provider')
        expect(s.deleted).toEqual([])
    })

    it('throws when the instance does not exist', async () => {
        const s = useStore([])

        await expect(removeProvider('nope')).rejects.toThrow('Provider instance nope not found')
        expect(s.deleted).toEqual([])
    })

    it('deletes an unmanaged provider', async () => {
        const s = useStore([row({ id: 'inst-byok', managed: false })])

        await removeProvider('inst-byok')

        expect(s.deleted).toEqual(['inst-byok'])
    })
})

describe('reorderProviders', () => {
    it('always writes preferenceOrder, and only the chat column for a chat reorder', async () => {
        const s = useStore([])

        await reorderProviders('ws-1', ['a', 'b'], 'chat')

        expect(s.orders.map(o => o.instanceId)).toEqual(['a', 'b'])
        expect(s.orders[0]!.order.preferenceOrder).toBe(0)
        expect(s.orders[0]!.order.chatPreferenceOrder).toBe(0)
        expect(s.orders[0]!.order.embeddingPreferenceOrder).toBeUndefined()
        expect(s.orders[1]!.order.preferenceOrder).toBe(1)
    })

    it('writes only the embedding column for an embedding reorder', async () => {
        const s = useStore([])

        await reorderProviders('ws-1', ['a'], 'embedding')

        expect(s.orders[0]!.order.preferenceOrder).toBe(0)
        expect(s.orders[0]!.order.embeddingPreferenceOrder).toBe(0)
        expect(s.orders[0]!.order.chatPreferenceOrder).toBeUndefined()
    })

    it('writes both capability columns for a global reorder', async () => {
        const s = useStore([])

        await reorderProviders('ws-1', ['a'])

        expect(s.orders[0]!.order).toMatchObject({
            preferenceOrder: 0,
            chatPreferenceOrder: 0,
            embeddingPreferenceOrder: 0,
        })
    })
})

describe('reads and updates', () => {
    it('lists a workspace in preference order and skips other workspaces', async () => {
        useStore([
            row({ id: 'b', workspaceId: 'ws-1', preferenceOrder: 1 }),
            row({ id: 'a', workspaceId: 'ws-1', preferenceOrder: 0 }),
            row({ id: 'x', workspaceId: 'ws-2', preferenceOrder: 0 }),
        ])

        expect((await listProviders('ws-1')).map(r => r.id)).toEqual(['a', 'b'])
        expect(await getProvider('x')).not.toBeNull()
        expect(await getProvider('missing')).toBeNull()
    })

    it('stamps updatedAt on every update', async () => {
        const s = useStore([row({ id: 'inst-1' })])

        const updated = await updateProvider('inst-1', { nickname: 'Renamed' })

        expect(updated!.nickname).toBe('Renamed')
        expect(s.updated[0]!.updates.updatedAt).toBeInstanceOf(Date)
    })

    it('returns null when updating a row that does not exist', async () => {
        useStore([])
        expect(await updateProvider('gone', { enabled: false })).toBeNull()
    })
})
