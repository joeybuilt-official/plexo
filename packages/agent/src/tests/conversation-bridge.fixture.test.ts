// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 of intelligence-hardening: fixture tests for the
 * conversation-bridge SCL concept extractor. Production call site:
 *     packages/agent/src/memory/conversation-bridge.ts:200-215
 *
 *     generateText(...) → strip ```json fences → JSON.parse →
 *     access parsed.concepts (no Zod)
 *
 * Shape: {"concepts":[{"label":"...","type":"entity"|"state"|"action"|"property"|"claim"}]}
 */

import { describe, it, expect } from 'vitest'

// ── Inline mirror ─────────────────────────────────────────────────────

type ConceptType = 'entity' | 'state' | 'action' | 'property' | 'claim'

interface ExtractedConcept {
    label: string
    type: ConceptType
}

interface ExtractResult {
    concepts: ExtractedConcept[]
}

function parseConceptExtraction(rawText: string): ExtractResult | null {
    try {
        const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        return JSON.parse(cleaned) as ExtractResult
    } catch {
        return null
    }
}

// ── Fixtures ───────────────────────────────────────────────────────────

interface Fixture {
    name: string
    llmResponse: string
    expected: ExtractResult | null
    expectCount?: number
}

const fixtures: Fixture[] = [
    {
        name: 'single entity concept',
        llmResponse: '{"concepts":[{"label":"pgvector extension","type":"entity"}]}',
        expected: { concepts: [{ label: 'pgvector extension', type: 'entity' }] },
        expectCount: 1,
    },
    {
        name: 'two concepts — entity + claim',
        llmResponse: '{"concepts":[{"label":"deepseek reasoner","type":"entity"},{"label":"reasoning models produce chain-of-thought","type":"claim"}]}',
        expected: {
            concepts: [
                { label: 'deepseek reasoner', type: 'entity' },
                { label: 'reasoning models produce chain-of-thought', type: 'claim' },
            ],
        },
        expectCount: 2,
    },
    {
        name: 'all five concept types',
        llmResponse: '{"concepts":[{"label":"router","type":"entity"},{"label":"active","type":"state"},{"label":"deploy","type":"action"},{"label":"fast","type":"property"},{"label":"routing is task-typed","type":"claim"}]}',
        expected: {
            concepts: [
                { label: 'router', type: 'entity' },
                { label: 'active', type: 'state' },
                { label: 'deploy', type: 'action' },
                { label: 'fast', type: 'property' },
                { label: 'routing is task-typed', type: 'claim' },
            ],
        },
        expectCount: 5,
    },
    {
        name: 'empty concepts — nothing worth extracting',
        llmResponse: '{"concepts":[]}',
        expected: { concepts: [] },
        expectCount: 0,
    },
    {
        name: 'markdown-fenced',
        llmResponse: '```json\n{"concepts":[{"label":"x","type":"entity"}]}\n```',
        expected: { concepts: [{ label: 'x', type: 'entity' }] },
        expectCount: 1,
    },
    {
        name: 'fenced without language',
        llmResponse: '```\n{"concepts":[{"label":"y","type":"state"}]}\n```',
        expected: { concepts: [{ label: 'y', type: 'state' }] },
        expectCount: 1,
    },
    {
        name: 'malformed JSON returns null',
        llmResponse: '{"concepts":[',
        expected: null,
    },
    {
        name: 'empty string returns null',
        llmResponse: '',
        expected: null,
    },
    {
        name: 'non-JSON garbage returns null',
        llmResponse: "I'll extract some concepts...",
        expected: null,
    },
    {
        name: 'concise label constraint not enforced at parse time — caller trusts shape',
        llmResponse: '{"concepts":[{"label":"this is a very long label that exceeds what the prompt asks for","type":"claim"}]}',
        expected: {
            concepts: [{ label: 'this is a very long label that exceeds what the prompt asks for', type: 'claim' }],
        },
        expectCount: 1,
    },
    {
        name: 'concept with bogus type still parses (no runtime enum check at call site)',
        llmResponse: '{"concepts":[{"label":"x","type":"bogus"}]}',
        expected: { concepts: [{ label: 'x', type: 'bogus' as ConceptType }] },
        expectCount: 1,
    },
    {
        name: 'top-level not an object — parses but caller uses optional chaining',
        llmResponse: '[]',
        expected: [] as unknown as ExtractResult,
    },
]

// ── Tests ──────────────────────────────────────────────────────────────

describe('conversation-bridge concept extraction parsing', () => {
    for (const fx of fixtures) {
        it(fx.name, () => {
            const parsed = parseConceptExtraction(fx.llmResponse)
            expect(parsed).toEqual(fx.expected)
            if (fx.expectCount !== undefined && parsed && 'concepts' in parsed) {
                expect(parsed.concepts).toHaveLength(fx.expectCount)
            }
        })
    }

    it('fixture count sanity', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(11)
    })
})
