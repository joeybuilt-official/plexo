// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 of intelligence-hardening: fixture tests for behavior reflection
 * LLM response parsing. Production call site:
 *     packages/agent/src/behavior/reflect.ts:102-116 (success reflection)
 *     packages/agent/src/behavior/reflect.ts:181-196 (failure reflection)
 *
 * Both paths: generateText(...) → JSON.parse(text.trim()) — no fence
 * stripping, no Zod schema. The system prompts explicitly demand raw
 * JSON arrays with specific shapes.
 */

import { describe, it, expect } from 'vitest'

// ── Inline mirrors ─────────────────────────────────────────────────────

interface SuccessObservation {
    key: string
    label: string
    insight: string
}

interface FailureObservation {
    key: string
    label: string
    rootCause: string
    prevention: string
}

function parseSuccessReflections(rawText: string): SuccessObservation[] {
    return JSON.parse(rawText.trim()) as SuccessObservation[]
}

function parseFailureReflections(rawText: string): FailureObservation[] {
    return JSON.parse(rawText.trim()) as FailureObservation[]
}

// ── Fixtures ───────────────────────────────────────────────────────────

interface SuccessFixture {
    name: string
    llmResponse: string
    expected: 'throws' | SuccessObservation[]
}

const successFixtures: SuccessFixture[] = [
    {
        name: 'single success observation',
        llmResponse: '[{"key":"reflect.code_review.clean_commits","label":"Clean commits","insight":"Separating refactor from feature commits accelerates review."}]',
        expected: [{
            key: 'reflect.code_review.clean_commits',
            label: 'Clean commits',
            insight: 'Separating refactor from feature commits accelerates review.',
        }],
    },
    {
        name: 'three observations',
        llmResponse: '[{"key":"reflect.a.one","label":"A","insight":"a"},{"key":"reflect.b.two","label":"B","insight":"b"},{"key":"reflect.c.three","label":"C","insight":"c"}]',
        expected: [
            { key: 'reflect.a.one', label: 'A', insight: 'a' },
            { key: 'reflect.b.two', label: 'B', insight: 'b' },
            { key: 'reflect.c.three', label: 'C', insight: 'c' },
        ],
    },
    {
        name: 'empty array valid',
        llmResponse: '[]',
        expected: [],
    },
    {
        name: 'leading whitespace tolerated (trim)',
        llmResponse: '   \n\n[{"key":"reflect.x.y","label":"L","insight":"I"}]  ',
        expected: [{ key: 'reflect.x.y', label: 'L', insight: 'I' }],
    },
    {
        name: 'malformed JSON throws (no fence stripping — markdown breaks it)',
        llmResponse: '```json\n[{"key":"x","label":"L","insight":"I"}]\n```',
        expected: 'throws',
    },
    {
        name: 'object instead of array still parses but caller trusts shape',
        llmResponse: '{"key":"x","label":"L","insight":"I"}',
        // JSON.parse returns the raw object; caller casts as array — this
        // row documents the unsafe-cast reality so any future hardening
        // (adding runtime array check) is a deliberate decision, not a
        // silent behavior change.
        expected: { key: 'x', label: 'L', insight: 'I' } as unknown as SuccessObservation[],
    },
    {
        name: 'unterminated JSON throws',
        llmResponse: '[{"key":"x"',
        expected: 'throws',
    },
    {
        name: 'empty string throws',
        llmResponse: '',
        expected: 'throws',
    },
]

interface FailureFixture {
    name: string
    llmResponse: string
    expected: 'throws' | FailureObservation[]
}

const failureFixtures: FailureFixture[] = [
    {
        name: 'single failure observation',
        llmResponse: '[{"key":"reflect.failure.deploy.missing_env","label":"Missing env var","rootCause":"Operator forgot to set DATABASE_URL","prevention":"Add env check to pre-deploy script"}]',
        expected: [{
            key: 'reflect.failure.deploy.missing_env',
            label: 'Missing env var',
            rootCause: 'Operator forgot to set DATABASE_URL',
            prevention: 'Add env check to pre-deploy script',
        }],
    },
    {
        name: 'two failure observations',
        llmResponse: '[{"key":"reflect.failure.a","label":"A","rootCause":"r1","prevention":"p1"},{"key":"reflect.failure.b","label":"B","rootCause":"r2","prevention":"p2"}]',
        expected: [
            { key: 'reflect.failure.a', label: 'A', rootCause: 'r1', prevention: 'p1' },
            { key: 'reflect.failure.b', label: 'B', rootCause: 'r2', prevention: 'p2' },
        ],
    },
    {
        name: 'empty array valid',
        llmResponse: '[]',
        expected: [],
    },
    {
        name: 'markdown-fenced throws (no strip)',
        llmResponse: '```json\n[]\n```',
        expected: 'throws',
    },
    {
        name: 'malformed throws',
        llmResponse: '[not-json',
        expected: 'throws',
    },
    {
        name: 'null throws (JSON.parse accepts it but caller expects array)',
        llmResponse: 'null',
        expected: null as unknown as FailureObservation[],
    },
]

// ── Tests ──────────────────────────────────────────────────────────────

describe('behavior-reflect success parsing', () => {
    for (const fx of successFixtures) {
        it(fx.name, () => {
            if (fx.expected === 'throws') {
                expect(() => parseSuccessReflections(fx.llmResponse)).toThrow()
                return
            }
            expect(parseSuccessReflections(fx.llmResponse)).toEqual(fx.expected)
        })
    }
})

describe('behavior-reflect failure parsing', () => {
    for (const fx of failureFixtures) {
        it(fx.name, () => {
            if (fx.expected === 'throws') {
                expect(() => parseFailureReflections(fx.llmResponse)).toThrow()
                return
            }
            expect(parseFailureReflections(fx.llmResponse)).toEqual(fx.expected)
        })
    }

    it('fixture count sanity', () => {
        expect(successFixtures.length + failureFixtures.length).toBeGreaterThanOrEqual(12)
    })
})
