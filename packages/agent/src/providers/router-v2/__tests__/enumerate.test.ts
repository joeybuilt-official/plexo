// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 Round-6 Phase 1 — candidate enumeration + capability gate.
 * Pure; no DB mock needed.
 */

import { describe, it, expect } from 'vitest'
import { enumerateModelCandidates, capabilityGate, requirementsForTask, type KnowledgeRow } from '../enumerate.js'
import type { ModelCandidate } from '../candidate.js'
import type { AvailableProvider } from '../selector.js'
import type { WorkspaceAISettings } from '../../registry.js'

const settings: WorkspaceAISettings = {} as WorkspaceAISettings

const ap = (provider: string, model?: string): AvailableProvider =>
    ({ provider, config: { provider, model } } as unknown as AvailableProvider)

describe('enumerateModelCandidates', () => {
    it('always includes each provider configured model even without a knowledge row (single-provider rule)', () => {
        const out = enumerateModelCandidates({
            taskType: 'planning',
            availableProviders: [ap('cerebras', 'llama-3.3-70b')],
            settings,
            knowledge: [],
        })
        expect(out).toHaveLength(1)
        expect(out[0]!.provider).toBe('cerebras')
        expect(out[0]!.modelId).toBe('llama-3.3-70b')
        // no knowledge → graceful-degrade defaults
        expect(out[0]!.costPerMIn).toBe(0)
        expect(out[0]!.contextWindow).toBe(0)
    })

    it('enriches the configured model from its knowledge row', () => {
        const knowledge: KnowledgeRow[] = [
            { provider: 'anthropic', modelId: 'claude-sonnet-4-6', contextWindow: 200_000, costPerMIn: 3, costPerMOut: 15, strengths: ['tools'], reliabilityScore: 0.97 },
        ]
        const out = enumerateModelCandidates({
            taskType: 'planning',
            availableProviders: [ap('anthropic', 'claude-sonnet-4-6')],
            settings,
            knowledge,
        })
        const c = out.find(x => x.modelId === 'claude-sonnet-4-6')!
        expect(c.costPerMIn).toBe(3)
        expect(c.contextWindow).toBe(200_000)
        expect(c.reliability).toBe(0.97)
        // manifest planning prior for anthropic = 5
        expect(c.priorScoreByTask.planning).toBe(5)
        // manifest capabilities merged (anthropic planning has long-context-200k)
        expect(c.capabilities.has('long-context-200k')).toBe(true)
        expect(c.capabilities.has('tool-calling')).toBe(true)
    })

    it('includes discovered models only when they have a knowledge row (∩ knowledge)', () => {
        const knowledge: KnowledgeRow[] = [
            { provider: 'groq', modelId: 'llama-3.3-70b', costPerMIn: 0.5, costPerMOut: 0.8 },
            { provider: 'groq', modelId: 'known-extra', costPerMIn: 0.1, costPerMOut: 0.2 },
        ]
        const out = enumerateModelCandidates({
            taskType: 'conversation',
            availableProviders: [ap('groq', 'llama-3.3-70b')],
            settings,
            knowledge,
            discovered: { groq: ['known-extra', 'unknown-discovered'] },
        })
        const ids = out.map(c => c.modelId).sort()
        expect(ids).toContain('llama-3.3-70b')
        expect(ids).toContain('known-extra')
        expect(ids).not.toContain('unknown-discovered') // no knowledge row → excluded
    })

    it('dedupes (provider, model) across configured + discovered', () => {
        const knowledge: KnowledgeRow[] = [
            { provider: 'groq', modelId: 'llama-3.3-70b', costPerMIn: 0.5, costPerMOut: 0.8 },
        ]
        const out = enumerateModelCandidates({
            taskType: 'conversation',
            availableProviders: [ap('groq', 'llama-3.3-70b')],
            settings,
            knowledge,
            discovered: { groq: ['llama-3.3-70b'] },
        })
        expect(out.filter(c => c.modelId === 'llama-3.3-70b')).toHaveLength(1)
    })

    it('honors the cap but never evicts a pinned configured model', () => {
        const knowledge: KnowledgeRow[] = Array.from({ length: 10 }, (_, i) => ({
            provider: 'openai',
            modelId: `extra-${i}`,
            costPerMIn: 1,
            costPerMOut: 1,
        }))
        const out = enumerateModelCandidates({
            taskType: 'planning',
            availableProviders: [ap('openai', 'gpt-4o'), ap('anthropic', 'claude-sonnet-4-6')],
            settings,
            knowledge,
            discovered: { openai: knowledge.map(k => k.modelId) },
            cap: 3,
        })
        expect(out.length).toBe(3)
        // both configured providers' models are pinned and present
        expect(out.some(c => c.provider === 'openai' && c.modelId === 'gpt-4o')).toBe(true)
        expect(out.some(c => c.provider === 'anthropic' && c.modelId === 'claude-sonnet-4-6')).toBe(true)
    })

    it('returns all pinned even when pinned count exceeds cap', () => {
        const out = enumerateModelCandidates({
            taskType: 'planning',
            availableProviders: [ap('openai', 'gpt-4o'), ap('anthropic', 'claude-sonnet-4-6'), ap('groq', 'llama-3.3-70b')],
            settings,
            knowledge: [],
            cap: 2,
        })
        expect(out.length).toBe(3) // pinned never dropped below provider count
    })
})

describe('capabilityGate', () => {
    const cand = (modelId: string, caps: string[]): ModelCandidate =>
        ({
            provider: 'x' as never,
            modelId,
            capabilities: new Set(caps) as never,
            contextWindow: 0,
            costPerMIn: 0,
            costPerMOut: 0,
            reliability: 1,
            priorScoreByTask: {},
        })

    it('keeps only candidates supporting all required capabilities', () => {
        const out = capabilityGate(['vision'], [
            cand('a', ['vision', 'tool-calling']),
            cand('b', ['tool-calling']),
        ])
        expect(out.map(c => c.modelId)).toEqual(['a'])
    })

    it('requires ALL listed capabilities (AND semantics)', () => {
        const out = capabilityGate(['vision', 'json-mode'], [
            cand('a', ['vision']),
            cand('b', ['vision', 'json-mode']),
        ])
        expect(out.map(c => c.modelId)).toEqual(['b'])
    })

    it('returns all candidates when no requirements', () => {
        const all = [cand('a', []), cand('b', ['vision'])]
        expect(capabilityGate([], all)).toHaveLength(2)
    })

    it('never empties to a block — falls back to unfiltered when nothing passes', () => {
        const all = [cand('a', ['tool-calling']), cand('b', ['streaming'])]
        const out = capabilityGate(['vision'], all)
        expect(out).toHaveLength(2) // single-provider rule
    })
})

describe('requirementsForTask', () => {
    it('requires json-mode for structured-output tasks', () => {
        expect(requirementsForTask('extraction')).toEqual(['json-mode'])
        expect(requirementsForTask('judging')).toEqual(['json-mode'])
    })
    it('has no hard requirements for other tasks', () => {
        expect(requirementsForTask('planning')).toEqual([])
        expect(requirementsForTask('conversation')).toEqual([])
        expect(requirementsForTask('summarization')).toEqual([])
    })
    it('filters extraction candidates to json-mode-capable via the gate', () => {
        const mk = (modelId: string, caps: string[]): ModelCandidate =>
            ({
                provider: 'x' as never, modelId, capabilities: new Set(caps) as never,
                contextWindow: 0, costPerMIn: 0, costPerMOut: 0, reliability: 1, priorScoreByTask: {},
            })
        const out = capabilityGate(requirementsForTask('extraction'), [mk('json', ['json-mode', 'tool-calling']), mk('plain', ['tool-calling'])])
        expect(out.map(c => c.modelId)).toEqual(['json'])
    })
})
