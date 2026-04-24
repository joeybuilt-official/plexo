// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 of intelligence-hardening: fixture tests for SCL reflection
 * LLM response parsing. Production call site:
 *     packages/agent/src/scl/reflect-scl.ts (reflectAndMutate)
 *
 * As of Phase 4 the production site now routes through
 * `callModel({ schema: SclReflectionSchema })` — the SDK does parse +
 * Zod validation itself. This fixture keeps the pre-Phase-4 text-mode
 * parser (`parseReflectResponse`) as a shape-pinning regression test
 * (in case a future phase rolls the schema mode back on a provider
 * quirk), and adds a Zod-validation block that pins the new schema
 * shape so any drift between the schema and the expected rows breaks
 * loudly. At least one "malformed output rejected" row is asserted.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// ── Inline mirror of production parser ────────────────────────────────

interface ReflectConcept {
    label: string
    type: string
    supersedes?: string
}

interface ReflectRelation {
    source: string
    target: string
    relation: string
    confidence: number
}

interface ReflectStructured {
    concepts?: ReflectConcept[]
    relations?: ReflectRelation[]
}

function parseReflectResponse(rawText: string): ReflectStructured | null {
    try {
        const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        return JSON.parse(cleaned) as ReflectStructured
    } catch {
        return null
    }
}

// ── Fixtures ───────────────────────────────────────────────────────────

interface Fixture {
    name: string
    llmResponse: string
    expected: ReflectStructured | null
    expectConceptCount?: number
    expectMutationViable?: boolean   // concepts.length > 0
}

const fixtures: Fixture[] = [
    {
        name: 'single concept, no relations',
        llmResponse: '{"concepts":[{"label":"auth middleware","type":"entity"}]}',
        expected: { concepts: [{ label: 'auth middleware', type: 'entity' }] },
        expectConceptCount: 1,
        expectMutationViable: true,
    },
    {
        name: 'multiple concepts + relations',
        llmResponse: '{"concepts":[{"label":"router","type":"entity"},{"label":"fallback chain","type":"pattern"}],"relations":[{"source":"router","target":"fallback chain","relation":"uses","confidence":0.9}]}',
        expected: {
            concepts: [
                { label: 'router', type: 'entity' },
                { label: 'fallback chain', type: 'pattern' },
            ],
            relations: [{ source: 'router', target: 'fallback chain', relation: 'uses', confidence: 0.9 }],
        },
        expectConceptCount: 2,
        expectMutationViable: true,
    },
    {
        name: 'concept with supersedes field',
        llmResponse: '{"concepts":[{"label":"new cache","type":"pattern","supersedes":"old cache"}]}',
        expected: { concepts: [{ label: 'new cache', type: 'pattern', supersedes: 'old cache' }] },
        expectConceptCount: 1,
        expectMutationViable: true,
    },
    {
        name: 'markdown-fenced response',
        llmResponse: '```json\n{"concepts":[{"label":"fastpath","type":"pattern"}]}\n```',
        expected: { concepts: [{ label: 'fastpath', type: 'pattern' }] },
        expectConceptCount: 1,
        expectMutationViable: true,
    },
    {
        name: 'fenced without language',
        llmResponse: '```\n{"concepts":[{"label":"x","type":"entity"}]}\n```',
        expected: { concepts: [{ label: 'x', type: 'entity' }] },
        expectConceptCount: 1,
        expectMutationViable: true,
    },
    {
        name: 'empty concepts array — no mutation',
        llmResponse: '{"concepts":[]}',
        expected: { concepts: [] },
        expectConceptCount: 0,
        expectMutationViable: false,
    },
    {
        name: 'no concepts field at all',
        llmResponse: '{}',
        expected: {},
        expectMutationViable: false,
    },
    {
        name: 'truncated to 5 concepts in caller loop (test parse yields all, caller slices)',
        llmResponse: '{"concepts":[{"label":"a","type":"entity"},{"label":"b","type":"entity"},{"label":"c","type":"entity"},{"label":"d","type":"entity"},{"label":"e","type":"entity"},{"label":"f","type":"entity"},{"label":"g","type":"entity"}]}',
        expected: {
            concepts: [
                { label: 'a', type: 'entity' },
                { label: 'b', type: 'entity' },
                { label: 'c', type: 'entity' },
                { label: 'd', type: 'entity' },
                { label: 'e', type: 'entity' },
                { label: 'f', type: 'entity' },
                { label: 'g', type: 'entity' },
            ],
        },
        expectConceptCount: 7,
        expectMutationViable: true,
    },
    {
        name: 'relations with confidence outside [0,1] still parses (caller clamps)',
        llmResponse: '{"concepts":[{"label":"a","type":"x"}],"relations":[{"source":"a","target":"b","relation":"r","confidence":1.5}]}',
        expected: {
            concepts: [{ label: 'a', type: 'x' }],
            relations: [{ source: 'a', target: 'b', relation: 'r', confidence: 1.5 }],
        },
        expectConceptCount: 1,
        expectMutationViable: true,
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
        llmResponse: 'Here are some concepts...',
        expected: null,
    },
    {
        name: 'nested objects preserved',
        llmResponse: '{"concepts":[{"label":"x","type":"entity"}],"relations":[{"source":"x","target":"y","relation":"rel","confidence":0.5}]}',
        expected: {
            concepts: [{ label: 'x', type: 'entity' }],
            relations: [{ source: 'x', target: 'y', relation: 'rel', confidence: 0.5 }],
        },
        expectConceptCount: 1,
        expectMutationViable: true,
    },
]

// ── Tests ──────────────────────────────────────────────────────────────

describe('reflect-scl fixture parsing', () => {
    for (const fx of fixtures) {
        it(fx.name, () => {
            const parsed = parseReflectResponse(fx.llmResponse)
            expect(parsed).toEqual(fx.expected)
            if (fx.expectConceptCount !== undefined) {
                expect(parsed?.concepts?.length ?? 0).toBe(fx.expectConceptCount)
            }
            if (fx.expectMutationViable !== undefined) {
                const viable = Boolean(parsed && parsed.concepts && parsed.concepts.length > 0)
                expect(viable).toBe(fx.expectMutationViable)
            }
        })
    }

    it('fixture count sanity', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(12)
    })
})

// ── Phase 4 schema-mode pinning ───────────────────────────────────────
//
// Mirrors the production `SclReflectionSchema` defined in
// `packages/agent/src/scl/reflect-scl.ts`. Kept inline so the test has
// no workspace import (same pattern as the other Phase 1 fixtures).

const SclConceptSchema = z.object({
    label: z.string().min(1),
    type: z.string(),
    supersedes: z.string().optional(),
})
const SclRelationSchema = z.object({
    source: z.string().min(1),
    target: z.string().min(1),
    relation: z.string(),
    confidence: z.number(),
})
const SclReflectionSchema = z.object({
    concepts: z.array(SclConceptSchema).default([]),
    relations: z.array(SclRelationSchema).default([]),
})

interface SchemaFixture {
    name: string
    input: unknown
    expectValid: boolean
}

const schemaFixtures: SchemaFixture[] = [
    {
        name: 'minimal valid concept',
        input: { concepts: [{ label: 'fastpath', type: 'pattern' }], relations: [] },
        expectValid: true,
    },
    {
        name: 'concept with supersedes is valid',
        input: {
            concepts: [{ label: 'new cache', type: 'pattern', supersedes: 'old cache' }],
            relations: [],
        },
        expectValid: true,
    },
    {
        name: 'concepts + relations round-trip',
        input: {
            concepts: [{ label: 'a', type: 'entity' }, { label: 'b', type: 'state' }],
            relations: [{ source: 'a', target: 'b', relation: 'CAUSES', confidence: 0.8 }],
        },
        expectValid: true,
    },
    {
        name: 'missing concepts/relations defaults to empty arrays',
        input: {},
        expectValid: true,
    },
    // ── Malformed rows — schema rejects ──────────────────────────────
    {
        name: 'MALFORMED: concept with empty label rejected',
        input: { concepts: [{ label: '', type: 'entity' }] },
        expectValid: false,
    },
    {
        name: 'MALFORMED: relation with numeric confidence as string rejected',
        input: {
            concepts: [{ label: 'a', type: 'entity' }],
            relations: [{ source: 'a', target: 'b', relation: 'x', confidence: 'high' }],
        },
        expectValid: false,
    },
    {
        name: 'MALFORMED: concepts field as non-array rejected',
        input: { concepts: 'not an array' },
        expectValid: false,
    },
]

describe('reflect-scl Zod schema pinning (Phase 4)', () => {
    for (const fx of schemaFixtures) {
        it(fx.name, () => {
            const result = SclReflectionSchema.safeParse(fx.input)
            expect(result.success).toBe(fx.expectValid)
        })
    }

    it('at least one malformed-row rejection asserted', () => {
        expect(schemaFixtures.some((fx) => !fx.expectValid)).toBe(true)
    })
})
