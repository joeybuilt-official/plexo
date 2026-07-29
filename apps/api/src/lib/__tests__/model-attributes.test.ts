// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2a — model-attributes helper tests.
 *
 * Pure deterministic tests for the cost class boundaries, latency
 * heuristic, strength normalisation, and the composeBestForHint
 * priority order. No DB, no fetch — just the helper.
 */

import { describe, it, expect } from 'vitest'
import {
    classifyCost,
    classifyLatency,
    normaliseStrengths,
    deriveCapabilities,
    composeBestForHint,
    computeModelAttributes,
} from '../model-attributes.js'

describe('classifyCost', () => {
    it('treats sub-cent blended cost as free', () => {
        expect(classifyCost(0)).toBe('free')
        expect(classifyCost(0.0009)).toBe('free')
    })
    it('buckets cheap', () => {
        expect(classifyCost(0.15)).toBe('cheap')
        expect(classifyCost(0.5)).toBe('cheap')
    })
    it('buckets standard', () => {
        expect(classifyCost(0.51)).toBe('standard')
        expect(classifyCost(5)).toBe('standard')
    })
    it('buckets premium past $5/M', () => {
        expect(classifyCost(5.01)).toBe('premium')
        expect(classifyCost(75)).toBe('premium')
    })
})

describe('classifyLatency', () => {
    it('marks groq + cerebras as fast', () => {
        expect(classifyLatency('groq', 'llama-3.3-70b-versatile')).toBe('fast')
        expect(classifyLatency('cerebras', 'llama3.1-8b')).toBe('fast')
    })
    it('detects fast model id keywords', () => {
        expect(classifyLatency('openai', 'gpt-4o-mini')).toBe('fast')
        expect(classifyLatency('anthropic', 'claude-haiku-4-5')).toBe('fast')
        expect(classifyLatency('google', 'gemini-flash')).toBe('fast')
    })
    it('detects slow reasoning models', () => {
        expect(classifyLatency('openai', 'o1-pro')).toBe('slow')
        expect(classifyLatency('anthropic', 'claude-opus-4-6')).toBe('slow')
        expect(classifyLatency('deepseek', 'deepseek-reasoner')).toBe('slow')
    })
    it('falls back to medium for unknown shapes', () => {
        expect(classifyLatency('openai', 'gpt-4o')).toBe('medium')
    })
})

describe('normaliseStrengths', () => {
    it('maps known strings to typed tags', () => {
        const out = normaliseStrengths(['reasoning', 'speed', 'CHEAP', 'coding'])
        expect(out).toEqual(expect.arrayContaining(['reasoning', 'speed', 'cheap', 'code']))
    })
    it('drops unknown strings', () => {
        const out = normaliseStrengths(['reasoning', 'mystery-tag'])
        expect(out).toEqual(['reasoning'])
    })
})

describe('deriveCapabilities', () => {
    it('maps tools / vision / json strings to capability flags', () => {
        const out = deriveCapabilities({
            provider: 'openai',
            modelId: 'gpt-4o',
            contextWindow: 64_000,
            costPerMIn: 1,
            costPerMOut: 2,
            strengths: ['tools', 'vision', 'structured_output'],
        })
        expect(out).toEqual(expect.arrayContaining(['tools', 'vision', 'json_mode']))
        expect(out).not.toContain('long_context')
    })
    it('marks long_context when window >= 128k', () => {
        const out = deriveCapabilities({
            provider: 'openai',
            modelId: 'gpt-4o',
            contextWindow: 128_000,
            costPerMIn: 1,
            costPerMOut: 2,
            strengths: [],
        })
        expect(out).toContain('long_context')
    })
})

describe('composeBestForHint', () => {
    it('prefers reasoning when present and not fast', () => {
        expect(composeBestForHint(['reasoning', 'code'], 'medium', 'standard'))
            .toMatch(/Deep reasoning/)
    })
    it('falls back to code', () => {
        expect(composeBestForHint(['code'], 'medium', 'cheap'))
            .toMatch(/Code generation/)
    })
    it('returns throughput hint for fast+cheap models', () => {
        expect(composeBestForHint([], 'fast', 'cheap'))
            .toMatch(/High-throughput/)
    })
    it('returns empty string when nothing distinctive', () => {
        expect(composeBestForHint([], 'medium', 'standard')).toBe('')
    })
})

describe('computeModelAttributes (integration)', () => {
    it('produces a stable record for a typical model row', () => {
        const out = computeModelAttributes({
            provider: 'openai',
            modelId: 'gpt-4o-mini',
            contextWindow: 128_000,
            costPerMIn: 0.15,
            costPerMOut: 0.6,
            strengths: ['speed', 'tools', 'vision'],
        })
        expect(out.latencyClass).toBe('fast')
        expect(out.costClass).toBe('cheap')
        expect(out.capabilities).toEqual(expect.arrayContaining(['tools', 'vision', 'long_context']))
        expect(out.strengths).toContain('speed')
        expect(out.blendedCostPerM).toBeCloseTo(0.375)
    })
})
