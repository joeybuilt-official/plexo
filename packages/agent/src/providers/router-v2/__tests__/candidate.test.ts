// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 Round-6 Phase 0 — ModelCandidate + capability derivation.
 * Pure; no DB mock needed.
 */

import { describe, it, expect } from 'vitest'
import {
    deriveCapabilities,
    buildModelCandidate,
    STRENGTH_TO_CAPABILITY,
} from '../candidate.js'

describe('deriveCapabilities', () => {
    it('maps known strengths to capabilities and ignores quality-only strengths', () => {
        const caps = deriveCapabilities({
            strengths: ['vision', 'tools', 'structured_output', 'speed', 'reasoning', 'coding', 'open-source', 'video'],
        })
        expect(caps.has('vision')).toBe(true)
        expect(caps.has('tool-calling')).toBe(true)
        expect(caps.has('json-mode')).toBe(true)
        expect(caps.has('low-latency')).toBe(true)
        // quality-only strengths do not become capabilities
        expect(caps.size).toBe(4)
    })

    it('ignores unknown strengths', () => {
        const caps = deriveCapabilities({ strengths: ['totally-made-up', 'vision'] })
        expect([...caps]).toEqual(['vision'])
    })

    it('derives long-context-200k at the 200k threshold', () => {
        const caps = deriveCapabilities({ contextWindow: 200_000 })
        expect(caps.has('long-context-200k')).toBe(true)
        expect(caps.has('long-context-1m')).toBe(false)
    })

    it('derives both long-context flags at >=1M', () => {
        const caps = deriveCapabilities({ contextWindow: 1_000_000 })
        expect(caps.has('long-context-1m')).toBe(true)
        expect(caps.has('long-context-200k')).toBe(true)
    })

    it('does not derive long-context below 200k', () => {
        const caps = deriveCapabilities({ contextWindow: 128_000 })
        expect(caps.has('long-context-200k')).toBe(false)
        expect(caps.has('long-context-1m')).toBe(false)
    })

    it('unions manifest capabilities', () => {
        const caps = deriveCapabilities({
            strengths: ['vision'],
            manifestCapabilities: ['tool-calling', 'streaming'],
        })
        expect(caps.has('vision')).toBe(true)
        expect(caps.has('tool-calling')).toBe(true)
        expect(caps.has('streaming')).toBe(true)
    })

    it('expands quirks that imply a capability', () => {
        const caps = deriveCapabilities({ quirks: ['openai-strict-json-mode'] })
        expect(caps.has('function-calling-strict')).toBe(true)
        expect(caps.has('json-mode')).toBe(true)
    })

    it('returns empty set for no signals', () => {
        expect(deriveCapabilities({}).size).toBe(0)
    })

    it('dedupes a capability asserted by multiple sources', () => {
        const caps = deriveCapabilities({
            strengths: ['tools'],
            manifestCapabilities: ['tool-calling'],
        })
        expect([...caps].filter(c => c === 'tool-calling')).toHaveLength(1)
    })

    it('STRENGTH_TO_CAPABILITY only covers hard-capability strengths', () => {
        expect(Object.keys(STRENGTH_TO_CAPABILITY).sort()).toEqual(
            ['speed', 'structured_output', 'tools', 'vision'],
        )
    })
})

describe('buildModelCandidate', () => {
    it('assembles from a full knowledge row', () => {
        const c = buildModelCandidate({
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-6',
            knowledge: {
                contextWindow: 200_000,
                costPerMIn: 3,
                costPerMOut: 15,
                strengths: ['reasoning', 'coding', 'tools'],
                reliabilityScore: 0.98,
            },
            manifestCapabilities: ['streaming'],
            priorScoreByTask: { planning: 5, codeGeneration: 5 },
        })
        expect(c.provider).toBe('anthropic')
        expect(c.modelId).toBe('claude-sonnet-4-6')
        expect(c.contextWindow).toBe(200_000)
        expect(c.costPerMIn).toBe(3)
        expect(c.costPerMOut).toBe(15)
        expect(c.reliability).toBe(0.98)
        expect(c.capabilities.has('tool-calling')).toBe(true)
        expect(c.capabilities.has('long-context-200k')).toBe(true)
        expect(c.capabilities.has('streaming')).toBe(true)
        expect(c.priorScoreByTask.planning).toBe(5)
    })

    it('degrades gracefully when knowledge is absent', () => {
        const c = buildModelCandidate({
            provider: 'groq',
            modelId: 'llama-3.3-70b',
            manifestCapabilities: ['tool-calling', 'low-latency'],
        })
        expect(c.contextWindow).toBe(0)
        expect(c.costPerMIn).toBe(0)
        expect(c.costPerMOut).toBe(0)
        expect(c.reliability).toBe(1)
        expect(c.capabilities.has('low-latency')).toBe(true)
        expect(c.capabilities.has('long-context-200k')).toBe(false)
        expect(c.priorScoreByTask).toEqual({})
    })
})
