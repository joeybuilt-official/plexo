// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stage 3 — model-knowledge sync through `ModelKnowledgeStore`.
 *
 * `models_knowledge` is what the router prices every decision against and what
 * the cost gate bills from, so a silent mistake in this mapping is expensive
 * and invisible. Before the port none of it could run without a live Postgres.
 * Pinned here:
 *   1. per-token prices become per-MILLION-token rates
 *   2. `default` keys and unpriced models are skipped
 *   3. strengths come from the capability flags, and are de-duplicated
 *   4. one provider's fetch failing does not abort the others
 *   5. the whole batch shares one `lastSyncedAt` instant
 *   6. a store failure is swallowed, not thrown at the cron
 *
 * `fetch` is stubbed; nothing here touches the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { syncModelKnowledge, setModelKnowledgeStore, ALLOWED_PROVIDERS } from '../knowledge.js'
import type { ModelKnowledgeStore, ModelKnowledgeRecord } from '../../model-knowledge.ports.js'

class FakeKnowledgeStore implements ModelKnowledgeStore {
    calls: ModelKnowledgeRecord[][] = []
    rejectWith: Error | null = null

    async upsertAll(records: ModelKnowledgeRecord[]): Promise<void> {
        if (this.rejectWith) throw this.rejectWith
        this.calls.push(records)
    }

    get records(): ModelKnowledgeRecord[] {
        return this.calls.flat()
    }
}

type PortkeyFixture = { pricing?: unknown; general?: unknown; fail?: boolean }

/** Serve Portkey pricing/general JSON per provider; anything unlisted 404s. */
function stubPortkey(fixtures: Record<string, PortkeyFixture>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const match = /\/(pricing|general)\/([a-z0-9-]+)\.json$/.exec(url)
        if (!match) return { ok: false, status: 404, json: async () => ({}) }
        const [, kind, provider] = match
        const fixture = fixtures[provider!]
        if (!fixture || fixture.fail) return { ok: false, status: 500, json: async () => ({}) }
        return {
            ok: true,
            status: 200,
            json: async () => (kind === 'pricing' ? fixture.pricing ?? {} : fixture.general ?? {}),
        }
    }))
}

/** A priced Portkey model entry. Prices are per token, as Portkey publishes them. */
function priced(inPerToken: number, outPerToken: number) {
    return {
        pricing_config: {
            pay_as_you_go: {
                request_token: { price: inPerToken },
                response_token: { price: outPerToken },
            },
        },
    }
}

let store: FakeKnowledgeStore

beforeEach(() => {
    store = new FakeKnowledgeStore()
    setModelKnowledgeStore(store)
    vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('syncModelKnowledge', () => {
    it('converts per-token prices to per-million-token rates', async () => {
        stubPortkey({
            deepseek: { pricing: { 'deepseek-chat': priced(0.00000027, 0.0000011) }, general: {} },
        })

        await syncModelKnowledge()

        const record = store.records.find(r => r.modelId === 'deepseek-chat')!
        expect(record.id).toBe('deepseek/deepseek-chat')
        expect(record.costPerMIn).toBeCloseTo(0.27, 6)
        expect(record.costPerMOut).toBeCloseTo(1.1, 6)
        expect(record.contextWindow).toBe(128000)
    })

    it('skips the "default" key and any model with no pay-as-you-go pricing', async () => {
        stubPortkey({
            groq: {
                pricing: {
                    default: priced(1, 1),
                    'llama-3.3-70b-versatile': priced(0.00000059, 0.00000079),
                    'unpriced-model': { pricing_config: {} },
                },
                general: {},
            },
        })

        await syncModelKnowledge()

        expect(store.records.map(r => r.modelId)).toEqual(['llama-3.3-70b-versatile'])
    })

    it('derives strengths from capability flags and de-duplicates them', async () => {
        stubPortkey({
            anthropic: {
                pricing: { 'claude-haiku-4-5': priced(0.000001, 0.000005) },
                general: {
                    'claude-haiku-4-5': {
                        type: { supported: ['image', 'tools'] },
                        params: [{ key: 'response_format', options: [{ value: 'json_schema' }] }],
                    },
                },
            },
        })

        await syncModelKnowledge()

        const strengths = store.records[0]!.strengths
        // vision + tools from the capability flags; structured_output from the
        // json_schema option; reasoning/coding + speed from the id heuristics.
        expect([...strengths].sort()).toEqual(
            ['coding', 'reasoning', 'speed', 'structured_output', 'tools', 'vision'],
        )
        expect(new Set(strengths).size).toBe(strengths.length)
    })

    it('de-duplicates a strength that the capability JSON declares twice', async () => {
        // The only input that actually reaches the dedupe: Portkey listing
        // `response_format` twice, each with a json_schema option. The id
        // heuristics each push once, so a single-param fixture would pass with
        // the dedupe deleted.
        stubPortkey({
            openai: {
                pricing: { 'gpt-4o-mini': priced(0.00000015, 0.0000006) },
                general: {
                    'gpt-4o-mini': {
                        params: [
                            { key: 'response_format', options: [{ value: 'json_schema' }] },
                            { key: 'response_format', options: [{ value: 'json_schema' }, { value: 'json_object' }] },
                        ],
                    },
                },
            },
        })

        await syncModelKnowledge()

        const strengths = store.records[0]!.strengths
        expect(strengths.filter(s => s === 'structured_output')).toHaveLength(1)
    })

    it('keeps going when one provider is unavailable', async () => {
        stubPortkey({
            groq: { fail: true },
            deepseek: { pricing: { 'deepseek-chat': priced(0.000001, 0.000002) }, general: {} },
        })

        await syncModelKnowledge()

        expect(store.records.map(r => r.provider)).toEqual(['deepseek'])
    })

    it('only asks for allowlisted providers', async () => {
        stubPortkey({})

        await syncModelKnowledge()

        const asked = new Set(
            (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls
                .map(([url]) => /\/(?:pricing|general)\/([a-z0-9-]+)\.json$/.exec(url)![1]!),
        )
        expect([...asked].sort()).toEqual([...ALLOWED_PROVIDERS].sort())
    })

    it('stamps the whole batch with one sync instant', async () => {
        stubPortkey({
            deepseek: { pricing: { a: priced(1, 1), b: priced(2, 2) }, general: {} },
            groq: { pricing: { c: priced(3, 3) }, general: {} },
        })

        await syncModelKnowledge()

        const stamps = new Set(store.records.map(r => r.lastSyncedAt.getTime()))
        expect(store.records).toHaveLength(3)
        expect(stamps.size).toBe(1)
    })

    it('swallows a store failure rather than throwing at the cron', async () => {
        store.rejectWith = new Error('models_knowledge is down')
        stubPortkey({ deepseek: { pricing: { 'deepseek-chat': priced(1, 1) }, general: {} } })

        await expect(syncModelKnowledge()).resolves.toBeUndefined()
    })
})
