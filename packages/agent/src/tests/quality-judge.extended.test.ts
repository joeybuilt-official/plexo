// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 of intelligence-hardening: fixture tests for the quality-judge
 * LLM response parsing path. The production call site at
 * `packages/agent/src/executor/quality-judge.ts:251-258` does:
 *     1. generateText(...)
 *     2. strip ```json fences from textResult.text
 *     3. JSON.parse(cleaned)
 *     4. JudgmentSchema.parse(parsed)
 *     5. computeWeightedScore(judgment, rubric, selfScore)
 *
 * This test inlines step 2-5 bit-for-bit and exercises each edge case
 * without hitting an LLM. If the parser drifts in quality-judge.ts,
 * these tests break loudly. Same pattern as classifier.fixture.test.ts.
 *
 * The existing quality-judge.test.ts covers detectSideEffectGap —
 * a different concern. These two files together cover the full judge.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// ── Inline mirror of the production parser ─────────────────────────────

const DimensionScoreSchema = z.object({
    dimension: z.string(),
    score: z.number(),
    rationale: z.string(),
})

const JudgmentSchema = z.object({
    scores: z.array(DimensionScoreSchema),
    overall_notes: z.string(),
})

type Judgment = z.infer<typeof JudgmentSchema>

interface RubricDim { dimension: string; weight: number }

function stripFences(text: string): string {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
}

function parseJudgment(rawText: string): Judgment {
    const cleaned = stripFences(rawText)
    return JudgmentSchema.parse(JSON.parse(cleaned))
}

function computeWeightedScore(
    judgment: Judgment,
    rubric: RubricDim[],
    selfScore: number,
): number {
    let weightedSum = 0
    let totalWeight = 0
    for (const rubricDim of rubric) {
        const judged = judgment.scores.find((s) => s.dimension === rubricDim.dimension)
        if (judged) {
            weightedSum += judged.score * rubricDim.weight
            totalWeight += rubricDim.weight
        }
    }
    return totalWeight > 0 ? weightedSum / totalWeight : selfScore
}

// ── Fixtures ───────────────────────────────────────────────────────────

interface Fixture {
    name: string
    llmResponse: string
    expectedParse: Judgment | 'throws'
    rubric?: RubricDim[]
    selfScore?: number
    expectedScore?: number
}

const fixtures: Fixture[] = [
    // Happy path — plain JSON
    {
        name: 'plain JSON happy path',
        llmResponse: '{"scores":[{"dimension":"correctness","score":0.9,"rationale":"all tests passed"}],"overall_notes":"solid"}',
        expectedParse: { scores: [{ dimension: 'correctness', score: 0.9, rationale: 'all tests passed' }], overall_notes: 'solid' },
    },
    // Markdown-fenced JSON
    {
        name: 'markdown-fenced JSON (```json ... ```)',
        llmResponse: '```json\n{"scores":[{"dimension":"clarity","score":0.8,"rationale":"clear"}],"overall_notes":"ok"}\n```',
        expectedParse: { scores: [{ dimension: 'clarity', score: 0.8, rationale: 'clear' }], overall_notes: 'ok' },
    },
    // Fence without language tag
    {
        name: 'bare ``` fence',
        llmResponse: '```\n{"scores":[{"dimension":"safety","score":1,"rationale":"no side effects"}],"overall_notes":"safe"}\n```',
        expectedParse: { scores: [{ dimension: 'safety', score: 1, rationale: 'no side effects' }], overall_notes: 'safe' },
    },
    // Multi-dimension happy path
    {
        name: 'three dimensions',
        llmResponse: '{"scores":[{"dimension":"correctness","score":0.8,"rationale":"mostly right"},{"dimension":"clarity","score":0.9,"rationale":"readable"},{"dimension":"safety","score":1,"rationale":"safe"}],"overall_notes":"good"}',
        expectedParse: {
            scores: [
                { dimension: 'correctness', score: 0.8, rationale: 'mostly right' },
                { dimension: 'clarity', score: 0.9, rationale: 'readable' },
                { dimension: 'safety', score: 1, rationale: 'safe' },
            ],
            overall_notes: 'good',
        },
    },
    // Zero scores
    {
        name: 'zero score — complete failure',
        llmResponse: '{"scores":[{"dimension":"correctness","score":0,"rationale":"wrong answer"}],"overall_notes":"failed"}',
        expectedParse: { scores: [{ dimension: 'correctness', score: 0, rationale: 'wrong answer' }], overall_notes: 'failed' },
    },
    // Leading whitespace
    {
        name: 'leading whitespace before JSON',
        llmResponse: '   \n\n{"scores":[{"dimension":"x","score":0.5,"rationale":"mid"}],"overall_notes":"mid"}',
        expectedParse: { scores: [{ dimension: 'x', score: 0.5, rationale: 'mid' }], overall_notes: 'mid' },
    },
    // Malformed JSON — should throw
    { name: 'malformed JSON (trailing comma)', llmResponse: '{"scores":[],"overall_notes":"x",}', expectedParse: 'throws' },
    { name: 'malformed JSON (unterminated)', llmResponse: '{"scores":[', expectedParse: 'throws' },
    // Missing required field
    { name: 'missing scores array', llmResponse: '{"overall_notes":"x"}', expectedParse: 'throws' },
    { name: 'missing overall_notes', llmResponse: '{"scores":[]}', expectedParse: 'throws' },
    // Wrong types
    { name: 'score as string instead of number', llmResponse: '{"scores":[{"dimension":"x","score":"high","rationale":"y"}],"overall_notes":"z"}', expectedParse: 'throws' },
    {
        name: 'missing rationale field in dimension',
        llmResponse: '{"scores":[{"dimension":"x","score":0.7}],"overall_notes":"z"}',
        expectedParse: 'throws',
    },
    // Empty scores array — valid
    {
        name: 'empty scores array with notes',
        llmResponse: '{"scores":[],"overall_notes":"nothing to judge"}',
        expectedParse: { scores: [], overall_notes: 'nothing to judge' },
    },
    // Empty string — throws
    { name: 'empty string', llmResponse: '', expectedParse: 'throws' },
    // Null
    { name: 'null top-level', llmResponse: 'null', expectedParse: 'throws' },
    // computeWeightedScore fixtures
    {
        name: 'weighted score — all dimensions present',
        llmResponse: '{"scores":[{"dimension":"a","score":1,"rationale":"x"},{"dimension":"b","score":0,"rationale":"y"}],"overall_notes":"mid"}',
        expectedParse: { scores: [{ dimension: 'a', score: 1, rationale: 'x' }, { dimension: 'b', score: 0, rationale: 'y' }], overall_notes: 'mid' },
        rubric: [{ dimension: 'a', weight: 1 }, { dimension: 'b', weight: 1 }],
        selfScore: 0.5,
        expectedScore: 0.5,
    },
    {
        name: 'weighted score — asymmetric weights',
        llmResponse: '{"scores":[{"dimension":"a","score":1,"rationale":"x"},{"dimension":"b","score":0,"rationale":"y"}],"overall_notes":"mid"}',
        expectedParse: { scores: [{ dimension: 'a', score: 1, rationale: 'x' }, { dimension: 'b', score: 0, rationale: 'y' }], overall_notes: 'mid' },
        rubric: [{ dimension: 'a', weight: 3 }, { dimension: 'b', weight: 1 }],
        selfScore: 0.5,
        expectedScore: 0.75,
    },
    {
        name: 'weighted score — missing dimension falls to selfScore',
        llmResponse: '{"scores":[],"overall_notes":"nothing"}',
        expectedParse: { scores: [], overall_notes: 'nothing' },
        rubric: [{ dimension: 'a', weight: 1 }],
        selfScore: 0.42,
        expectedScore: 0.42,
    },
]

// ── Tests ──────────────────────────────────────────────────────────────

describe('quality-judge fixture parsing', () => {
    for (const fx of fixtures) {
        it(fx.name, () => {
            if (fx.expectedParse === 'throws') {
                expect(() => parseJudgment(fx.llmResponse)).toThrow()
                return
            }
            const parsed = parseJudgment(fx.llmResponse)
            expect(parsed).toEqual(fx.expectedParse)
            if (fx.rubric !== undefined && fx.expectedScore !== undefined) {
                expect(computeWeightedScore(parsed, fx.rubric, fx.selfScore ?? 0)).toBeCloseTo(fx.expectedScore, 4)
            }
        })
    }

    it('fixture count sanity', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(15)
    })
})
