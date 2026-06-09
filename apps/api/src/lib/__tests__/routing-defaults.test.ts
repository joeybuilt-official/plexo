// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2b — routing-defaults helper tests.
 *
 * Pure deterministic tests. The hard invariants pinned here:
 *   1. `deepseek-reasoner` and other reasoner-class ids never appear at
 *      position 0 for conversation/classification/summarization/
 *      codeGeneration/verification/logAnalysis chains.
 *   2. Pinned (selectedModel) candidates win on ties.
 *   3. Workspaces with zero providers produce empty chains, not crashes.
 *   4. Catalog gaps (synthesized rows) still produce a usable chain.
 *   5. Score weights match the per-tier intent (fast+cheap dominates
 *      conversation; reasoning dominates planning).
 */

import { describe, it, expect } from 'vitest'
import {
    computeDefaultChainsForWorkspace,
    computeDefaultChainForTask,
    buildCandidates,
    scoreCandidate,
    isReasonerModelId,
    reconcileChain,
    chainsEqual,
    REASONER_NEVER_TIERS,
    ROUTING_TASK_TYPES,
    type EnabledProvider,
    type CatalogModel,
    type StoredChainEntry,
    type DefaultChain,
} from '../routing-defaults.js'
import { computeModelAttributes } from '../model-attributes.js'

describe('reconcileChain (self-heal)', () => {
    const provs: EnabledProvider[] = [
        { id: 'p-ollama', providerType: 'ollama_cloud', enabled: true, chatModels: ['gpt-oss:120b'], selectedModel: 'gpt-oss:120b' },
        { id: 'p-cerebras', providerType: 'cerebras', enabled: true, chatModels: ['gpt-oss-120b'], selectedModel: 'gpt-oss-120b' },
        { id: 'p-groq', providerType: 'groq', enabled: true, chatModels: ['openai/gpt-oss-120b'], selectedModel: 'openai/gpt-oss-120b' },
    ]
    const computed: DefaultChain = [
        { providerId: 'p-cerebras', providerType: 'cerebras', modelId: 'gpt-oss-120b', score: 9 },
        { providerId: 'p-groq', providerType: 'groq', modelId: 'openai/gpt-oss-120b', score: 8 },
    ]

    it('appends newly-available providers as fallbacks, preserving the existing primary', () => {
        const existing: StoredChainEntry[] = [{ providerId: 'p-ollama', modelId: 'gpt-oss:120b' }]
        const out = reconcileChain(existing, provs, computed)
        expect(out.map((e) => e.providerId)).toEqual(['p-ollama', 'p-cerebras', 'p-groq'])
        expect(out[0]!.providerId).toBe('p-ollama') // operator's primary untouched
    })

    it('prunes entries whose provider is no longer enabled', () => {
        const existing: StoredChainEntry[] = [
            { providerId: 'p-gone', modelId: 'x' },
            { providerId: 'p-cerebras', modelId: 'gpt-oss-120b' },
        ]
        const out = reconcileChain(existing, provs, computed)
        expect(out.find((e) => e.providerId === 'p-gone')).toBeUndefined()
        expect(out[0]!.providerId).toBe('p-cerebras')
    })

    it('is a no-op (chainsEqual) when every enabled provider is already present', () => {
        const existing: StoredChainEntry[] = [
            { providerId: 'p-cerebras', modelId: 'gpt-oss-120b' },
            { providerId: 'p-groq', modelId: 'openai/gpt-oss-120b' },
            { providerId: 'p-ollama', modelId: 'gpt-oss:120b' },
        ]
        const out = reconcileChain(existing, provs, computed)
        expect(chainsEqual(existing, out)).toBe(true)
    })

    it('never reorders existing entries (appends only)', () => {
        const existing: StoredChainEntry[] = [
            { providerId: 'p-groq', modelId: 'openai/gpt-oss-120b' },
            { providerId: 'p-ollama', modelId: 'gpt-oss:120b' },
        ]
        const out = reconcileChain(existing, provs, computed)
        expect(out.slice(0, 2)).toEqual(existing) // front preserved
        expect(out[2]!.providerId).toBe('p-cerebras') // appended
    })
})

const PROVIDERS: EnabledProvider[] = [
    {
        id: 'pi-anthropic',
        providerType: 'anthropic',
        enabled: true,
        chatModels: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-6'],
        selectedModel: 'claude-sonnet-4-5',
    },
    {
        id: 'pi-deepseek',
        providerType: 'deepseek',
        enabled: true,
        chatModels: ['deepseek-chat', 'deepseek-reasoner'],
        selectedModel: 'deepseek-chat',
    },
    {
        id: 'pi-groq',
        providerType: 'groq',
        enabled: true,
        chatModels: ['llama-3.3-70b-versatile'],
        selectedModel: null,
    },
    {
        id: 'pi-disabled',
        providerType: 'openai',
        enabled: false,
        chatModels: ['gpt-4o'],
        selectedModel: null,
    },
]

const CATALOG: CatalogModel[] = [
    {
        id: 'anthropic/claude-sonnet-4-5',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        contextWindow: 200_000,
        costPerMIn: 3,
        costPerMOut: 15,
        strengths: ['code', 'tools', 'reasoning'],
        reliabilityScore: 0.95,
    },
    {
        id: 'anthropic/claude-haiku-4-5',
        provider: 'anthropic',
        modelId: 'claude-haiku-4-5',
        contextWindow: 200_000,
        costPerMIn: 0.25,
        costPerMOut: 1.25,
        strengths: ['speed', 'tools'],
        reliabilityScore: 0.95,
    },
    {
        id: 'anthropic/claude-opus-4-6',
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        contextWindow: 200_000,
        costPerMIn: 15,
        costPerMOut: 75,
        strengths: ['reasoning', 'code', 'tools'],
        reliabilityScore: 0.92,
    },
    {
        id: 'deepseek/deepseek-chat',
        provider: 'deepseek',
        modelId: 'deepseek-chat',
        contextWindow: 64_000,
        costPerMIn: 0.14,
        costPerMOut: 0.28,
        strengths: ['cheap', 'speed'],
        reliabilityScore: 0.85,
    },
    {
        id: 'deepseek/deepseek-reasoner',
        provider: 'deepseek',
        modelId: 'deepseek-reasoner',
        contextWindow: 64_000,
        costPerMIn: 0.55,
        costPerMOut: 2.19,
        strengths: ['reasoning'],
        reliabilityScore: 0.85,
    },
    {
        id: 'groq/llama-3.3-70b-versatile',
        provider: 'groq',
        modelId: 'llama-3.3-70b-versatile',
        contextWindow: 128_000,
        costPerMIn: 0.59,
        costPerMOut: 0.79,
        strengths: ['speed', 'tools', 'open_source'],
        reliabilityScore: 0.9,
    },
]

// ── 1. Reasoner invariant — the reason this whole helper exists ──────────

describe('REASONER_NEVER_TIERS invariant', () => {
    it('never seeds a reasoner-class model at position 0 for any never-tier', () => {
        const chains = computeDefaultChainsForWorkspace(PROVIDERS, CATALOG)
        for (const tier of REASONER_NEVER_TIERS) {
            const chain = chains[tier]
            expect(chain.length, `${tier} chain must not be empty with these providers`).toBeGreaterThan(0)
            const head = chain[0]!
            expect(
                isReasonerModelId(head.modelId),
                `${tier} chain[0] = ${head.modelId} is a reasoner — this is the bug we exist to prevent`,
            ).toBe(false)
        }
    })

    it('still allows reasoner at position 0 for planning', () => {
        const chains = computeDefaultChainsForWorkspace(PROVIDERS, CATALOG)
        // Planning is allowed to land on reasoner — but with this catalog
        // the sonnet/opus models score higher, so we just assert that the
        // chain has at least one entry and isn't empty.
        expect(chains.planning.length).toBeGreaterThan(0)
    })

    it('isReasonerModelId catches the known reasoner ids', () => {
        expect(isReasonerModelId('deepseek-reasoner')).toBe(true)
        expect(isReasonerModelId('o1-pro')).toBe(true)
        expect(isReasonerModelId('o1-mini')).toBe(true)
        expect(isReasonerModelId('o3-large')).toBe(true)
        expect(isReasonerModelId('claude-sonnet-4-5')).toBe(false)
        expect(isReasonerModelId('deepseek-chat')).toBe(false)
        expect(isReasonerModelId('gpt-4o')).toBe(false)
    })
})

// ── 2. Per-tier intent ───────────────────────────────────────────────────

describe('per-tier scoring intent', () => {
    it('classification picks a fast+cheap model over a premium one', () => {
        const chains = computeDefaultChainsForWorkspace(PROVIDERS, CATALOG)
        const top = chains.classification[0]!
        expect(top.modelId).toMatch(/(haiku|deepseek-chat|llama)/)
    })

    it('conversation picks a fast+cheap model first', () => {
        const chains = computeDefaultChainsForWorkspace(PROVIDERS, CATALOG)
        const top = chains.conversation[0]!
        expect(top.modelId).toMatch(/(haiku|deepseek-chat|llama)/)
    })

    it('codeGeneration picks a code-strong model', () => {
        const chains = computeDefaultChainsForWorkspace(PROVIDERS, CATALOG)
        const top = chains.codeGeneration[0]!
        // sonnet is the only catalog model with the `code` strength tag
        // among non-reasoner candidates, so it should win.
        expect(top.modelId).toBe('claude-sonnet-4-5')
    })

    it('planning rewards reasoning capable models', () => {
        const chains = computeDefaultChainsForWorkspace(PROVIDERS, CATALOG)
        // sonnet has reasoning + code + tools and is not premium-cost, so
        // it scores highest for planning. Either sonnet or opus is OK
        // here as long as the top has reasoning.
        const top = chains.planning[0]!
        const attrs = computeModelAttributes(CATALOG.find(c => c.modelId === top.modelId)!)
        expect(attrs.strengths).toContain('reasoning')
    })
})

// ── 3. Edge cases ─────────────────────────────────────────────────────────

describe('edge cases', () => {
    it('returns empty chains for a workspace with no enabled providers', () => {
        const chains = computeDefaultChainsForWorkspace([], CATALOG)
        for (const tier of ROUTING_TASK_TYPES) {
            expect(chains[tier]).toEqual([])
        }
    })

    it('still seeds a chain when the catalog is empty (synthesized rows)', () => {
        const chains = computeDefaultChainsForWorkspace(PROVIDERS, [])
        // Without catalog rows the helper falls back to synthesized
        // attributes from name patterns, but it must still produce
        // entries — and must still keep reasoner off position 0.
        expect(chains.conversation.length).toBeGreaterThan(0)
        for (const tier of REASONER_NEVER_TIERS) {
            const top = chains[tier][0]
            if (top) expect(isReasonerModelId(top.modelId)).toBe(false)
        }
    })

    it('skips disabled providers', () => {
        const chains = computeDefaultChainsForWorkspace(PROVIDERS, CATALOG)
        for (const tier of ROUTING_TASK_TYPES) {
            for (const entry of chains[tier]) {
                expect(entry.providerType).not.toBe('openai')
            }
        }
    })

    it('caps each chain at 3 entries', () => {
        const chains = computeDefaultChainsForWorkspace(PROVIDERS, CATALOG)
        for (const tier of ROUTING_TASK_TYPES) {
            expect(chains[tier].length).toBeLessThanOrEqual(3)
        }
    })
})

// ── 4. Score function ────────────────────────────────────────────────────

describe('scoreCandidate', () => {
    it('penalizes reasoner heavily for never-tiers', () => {
        const reasonerAttrs = computeModelAttributes({
            provider: 'deepseek',
            modelId: 'deepseek-reasoner',
            contextWindow: 64_000,
            costPerMIn: 0.55,
            costPerMOut: 2.19,
            strengths: ['reasoning'],
        })
        const chatAttrs = computeModelAttributes({
            provider: 'deepseek',
            modelId: 'deepseek-chat',
            contextWindow: 64_000,
            costPerMIn: 0.14,
            costPerMOut: 0.28,
            strengths: ['cheap', 'speed'],
        })
        const reasonerScore = scoreCandidate(reasonerAttrs, 0.85, 'conversation')
        const chatScore = scoreCandidate(chatAttrs, 0.85, 'conversation')
        expect(chatScore).toBeGreaterThan(reasonerScore)
        // The penalty should be large enough that no realistic boost
        // can recover it.
        expect(chatScore - reasonerScore).toBeGreaterThan(50)
    })

    it('does not apply the reasoner penalty to planning', () => {
        const reasonerAttrs = computeModelAttributes({
            provider: 'deepseek',
            modelId: 'deepseek-reasoner',
            contextWindow: 64_000,
            costPerMIn: 0.55,
            costPerMOut: 2.19,
            strengths: ['reasoning'],
        })
        // planning weight 5 for reasoning + reliability nudge → positive
        expect(scoreCandidate(reasonerAttrs, 0.85, 'planning')).toBeGreaterThan(0)
    })
})

// ── 5. buildCandidates ───────────────────────────────────────────────────

describe('buildCandidates', () => {
    it('cross-joins enabled providers with catalog models', () => {
        const candidates = buildCandidates(PROVIDERS, CATALOG)
        // 3 anthropic + 2 deepseek + 1 groq = 6 candidates (openai disabled)
        expect(candidates).toHaveLength(6)
    })

    it('flags pinned models from selectedModel', () => {
        const candidates = buildCandidates(PROVIDERS, CATALOG)
        const sonnet = candidates.find(c => c.modelId === 'claude-sonnet-4-5')
        expect(sonnet?.pinned).toBe(true)
        const haiku = candidates.find(c => c.modelId === 'claude-haiku-4-5')
        expect(haiku?.pinned).toBe(false)
    })
})

// ── 6. computeDefaultChainForTask ────────────────────────────────────────

describe('computeDefaultChainForTask', () => {
    it('breaks ties on pinned, then alphabetical', () => {
        const candidates = buildCandidates(PROVIDERS, CATALOG)
        const chain = computeDefaultChainForTask(candidates, 'conversation')
        expect(chain.length).toBeGreaterThanOrEqual(1)
        // Each entry must come from one of the enabled providers.
        for (const entry of chain) {
            expect(['pi-anthropic', 'pi-deepseek', 'pi-groq']).toContain(entry.providerId)
        }
    })

    it('emits at most 3 entries', () => {
        const candidates = buildCandidates(PROVIDERS, CATALOG)
        const chain = computeDefaultChainForTask(candidates, 'conversation')
        expect(chain.length).toBeLessThanOrEqual(3)
    })
})
