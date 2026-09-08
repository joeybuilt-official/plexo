// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stage 3 — legacy provider migration through `ProviderMigrationStore`.
 *
 * This runs on the first `GET /api/v1/workspaces/:id/providers` of any
 * unmigrated workspace, so a mistake here silently mis-seeds a workspace's
 * whole provider set — and before the port none of it could run without a
 * live Postgres. These pin the rules the migration owns:
 *   1. it is idempotent: an already-migrated workspace is left alone
 *   2. primary goes first, then the fallback chain, de-duplicated
 *   3. both legacy spellings of the chain and of the model are honoured
 *   4. a provider with no vault entry, or an unconfigured one, is skipped
 *   5. one provider failing does not abort the rest
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
    migrateWorkspaceProviders,
    needsMigration,
    setProviderMigrationStore,
} from '../migrate-to-instances.js'
import { setProviderInstanceStore } from '../instances.js'
import type { ProviderMigrationStore, LegacyProviderConfig } from '../../provider-migration.ports.js'
import type {
    ProviderInstanceStore,
    ProviderInstanceRow,
    ProviderInstanceInsert,
} from '../../provider-instances.ports.js'

class FakeMigrationStore implements ProviderMigrationStore {
    anyInstances = false
    unmanagedInstances = false
    legacy: LegacyProviderConfig | null = null

    async hasAnyInstances(): Promise<boolean> { return this.anyInstances }
    async hasUnmanagedInstances(): Promise<boolean> { return this.unmanagedInstances }
    async getLegacyProviderConfig(): Promise<LegacyProviderConfig | null> { return this.legacy }
}

/** Captures what the migration hands to `addProvider`. */
class CapturingInstanceStore implements ProviderInstanceStore {
    readonly inserted: ProviderInstanceInsert[] = []
    failFor: string | null = null

    async listByWorkspace(): Promise<ProviderInstanceRow[]> { return [] }
    async getById(): Promise<ProviderInstanceRow | null> { return null }
    async getOwnership(): Promise<{ workspaceId: string; managed: boolean } | null> { return null }
    async maxPreferenceOrder(): Promise<number | null> { return this.inserted.length - 1 || null }
    async insert(input: ProviderInstanceInsert): Promise<ProviderInstanceRow> {
        if (this.failFor === input.providerType) throw new Error(`insert failed for ${input.providerType}`)
        this.inserted.push(input)
        return { id: `inst-${this.inserted.length}`, ...input } as unknown as ProviderInstanceRow
    }
    async update(): Promise<ProviderInstanceRow | null> { return null }
    async delete(): Promise<void> {}
    async setPreferenceOrder(): Promise<void> {}
}

let migration: FakeMigrationStore
let instances: CapturingInstanceStore

beforeEach(() => {
    migration = new FakeMigrationStore()
    instances = new CapturingInstanceStore()
    setProviderMigrationStore(migration)
    setProviderInstanceStore(instances)
})

describe('needsMigration', () => {
    it('is true only when the workspace has no instances at all', async () => {
        migration.anyInstances = false
        expect(await needsMigration('ws-1')).toBe(true)

        migration.anyInstances = true
        expect(await needsMigration('ws-1')).toBe(false)
    })
})

describe('migrateWorkspaceProviders', () => {
    it('does nothing when the workspace already has user-created instances', async () => {
        migration.unmanagedInstances = true
        migration.legacy = { vault: { openai: { apiKey: 'enc:x' } }, arbiter: { primaryProvider: 'openai' } }

        const result = await migrateWorkspaceProviders('ws-1')

        expect(result.migratedProviders).toEqual([])
        expect(instances.inserted).toEqual([])
    })

    it('does nothing when there is no legacy settings blob', async () => {
        migration.legacy = null

        const result = await migrateWorkspaceProviders('ws-1')

        expect(result.migratedProviders).toEqual([])
        expect(result.errors).toEqual([])
        expect(instances.inserted).toEqual([])
    })

    it('migrates the primary first, then the chain, without duplicating it', async () => {
        migration.legacy = {
            vault: {
                anthropic: { apiKey: 'enc:a' },
                groq: { apiKey: 'enc:g' },
                deepseek: { apiKey: 'enc:d' },
            },
            arbiter: {
                primaryProvider: 'groq',
                // 'groq' repeats the primary — caught by the `.filter()` that
                // builds the list. 'anthropic' repeats itself — caught only by
                // the `seen` set, which is the half a chain-without-repeats
                // would never exercise.
                fallbackChain: ['anthropic', 'groq', 'anthropic', 'deepseek'],
            },
        }

        const result = await migrateWorkspaceProviders('ws-1')

        expect(result.migratedProviders).toEqual(['groq', 'anthropic', 'deepseek'])
        expect(instances.inserted.map(i => i.nickname)).toEqual(['Groq', 'Anthropic', 'DeepSeek'])
    })

    it('honours the legacy spellings for the chain and the model', async () => {
        migration.legacy = {
            vault: { openai: { apiKey: 'enc:o', baseUrl: 'https://proxy.example' } },
            arbiter: {
                primary: 'openai',
                fallbackOrder: [],
                providers: { openai: { defaultModel: 'gpt-4o-mini' } },
            },
        }

        await migrateWorkspaceProviders('ws-1')

        expect(instances.inserted[0]).toMatchObject({
            providerType: 'openai',
            nickname: 'OpenAI',
            selectedModel: 'gpt-4o-mini',
            endpointUrl: 'https://proxy.example',
            encryptedKey: 'enc:o',
        })
    })

    it('skips a chain entry with no vault record, and an unconfigured one', async () => {
        migration.legacy = {
            vault: {
                mistral: { status: 'unconfigured' },
                xai: { apiKey: 'enc:x' },
            },
            arbiter: { fallbackChain: ['ghost', 'mistral', 'xai'] },
        }

        const result = await migrateWorkspaceProviders('ws-1')

        expect(result.migratedProviders).toEqual(['xai'])
    })

    it('keeps an unconfigured entry that still carries a base URL', async () => {
        migration.legacy = {
            vault: { ollama: { status: 'unconfigured', baseUrl: 'http://box:11434' } },
            arbiter: { fallbackChain: ['ollama'] },
        }

        const result = await migrateWorkspaceProviders('ws-1')

        expect(result.migratedProviders).toEqual(['ollama'])
        expect(instances.inserted[0]!.endpointUrl).toBe('http://box:11434')
    })

    it('records one provider failing and still migrates the rest', async () => {
        instances.failFor = 'groq'
        migration.legacy = {
            vault: { groq: { apiKey: 'enc:g' }, deepseek: { apiKey: 'enc:d' } },
            arbiter: { fallbackChain: ['groq', 'deepseek'] },
        }

        const result = await migrateWorkspaceProviders('ws-1')

        expect(result.migratedProviders).toEqual(['deepseek'])
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0]).toContain('Failed to migrate groq')
    })

    it('reports a store failure instead of throwing', async () => {
        migration.getLegacyProviderConfig = async () => { throw new Error('workspaces is down') }

        const result = await migrateWorkspaceProviders('ws-1')

        expect(result.migratedProviders).toEqual([])
        expect(result.errors[0]).toContain('Migration failed: workspaces is down')
    })
})
