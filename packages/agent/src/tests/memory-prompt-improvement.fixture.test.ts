// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 of intelligence-hardening: fixture tests for the
 * prompt-improvement LLM response parsing. Production call site:
 *     packages/agent/src/memory/prompt-improvement.ts:120-150
 *
 *     generateText(...) → strip ```json fences → JSON.parse →
 *     PatchesSchema.parse(...).patches
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// ── Schema — mirror production ────────────────────────────────────────

const PromptPatchSchema = z.object({
    section: z.enum(['tool_selection', 'error_handling', 'code_quality', 'planning', 'output_format']),
    original: z.string(),
    proposed: z.string(),
    rationale: z.string(),
    supportingTaskIds: z.array(z.string()),
})

const PatchesSchema = z.object({
    patches: z.array(PromptPatchSchema).max(3),
})

type Patch = z.infer<typeof PromptPatchSchema>

function parsePatchesResponse(rawText: string): Patch[] {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    return PatchesSchema.parse(JSON.parse(cleaned)).patches
}

// ── Fixtures ───────────────────────────────────────────────────────────

interface Fixture {
    name: string
    llmResponse: string
    expected: 'throws' | Patch[]
    expectCount?: number
}

const fixtures: Fixture[] = [
    {
        name: 'single tool_selection patch',
        llmResponse: '{"patches":[{"section":"tool_selection","original":"prefer grep","proposed":"prefer ripgrep for speed","rationale":"grep is slower on large repos","supportingTaskIds":["t1","t2"]}]}',
        expected: [{
            section: 'tool_selection',
            original: 'prefer grep',
            proposed: 'prefer ripgrep for speed',
            rationale: 'grep is slower on large repos',
            supportingTaskIds: ['t1', 't2'],
        }],
        expectCount: 1,
    },
    {
        name: 'three-patch output (max allowed)',
        llmResponse: `{"patches":[
            {"section":"error_handling","original":"catch all","proposed":"catch and retry on 503","rationale":"transient","supportingTaskIds":["t1"]},
            {"section":"code_quality","original":"no comments","proposed":"comment non-obvious","rationale":"readability","supportingTaskIds":["t2"]},
            {"section":"planning","original":"skip plan","proposed":"always plan","rationale":"fewer errors","supportingTaskIds":["t3"]}
        ]}`,
        expected: [
            { section: 'error_handling', original: 'catch all', proposed: 'catch and retry on 503', rationale: 'transient', supportingTaskIds: ['t1'] },
            { section: 'code_quality', original: 'no comments', proposed: 'comment non-obvious', rationale: 'readability', supportingTaskIds: ['t2'] },
            { section: 'planning', original: 'skip plan', proposed: 'always plan', rationale: 'fewer errors', supportingTaskIds: ['t3'] },
        ],
        expectCount: 3,
    },
    {
        name: 'output_format patch with empty supportingTaskIds',
        llmResponse: '{"patches":[{"section":"output_format","original":"markdown","proposed":"plain text","rationale":"api consumers","supportingTaskIds":[]}]}',
        expected: [{ section: 'output_format', original: 'markdown', proposed: 'plain text', rationale: 'api consumers', supportingTaskIds: [] }],
        expectCount: 1,
    },
    {
        name: 'markdown-fenced',
        llmResponse: '```json\n{"patches":[{"section":"planning","original":"a","proposed":"b","rationale":"c","supportingTaskIds":["t1"]}]}\n```',
        expected: [{ section: 'planning', original: 'a', proposed: 'b', rationale: 'c', supportingTaskIds: ['t1'] }],
        expectCount: 1,
    },
    {
        name: 'empty patches array',
        llmResponse: '{"patches":[]}',
        expected: [],
        expectCount: 0,
    },
    {
        name: 'four patches — exceeds max, throws',
        llmResponse: `{"patches":[
            {"section":"tool_selection","original":"a","proposed":"b","rationale":"c","supportingTaskIds":["t1"]},
            {"section":"error_handling","original":"a","proposed":"b","rationale":"c","supportingTaskIds":["t2"]},
            {"section":"code_quality","original":"a","proposed":"b","rationale":"c","supportingTaskIds":["t3"]},
            {"section":"planning","original":"a","proposed":"b","rationale":"c","supportingTaskIds":["t4"]}
        ]}`,
        expected: 'throws',
    },
    {
        name: 'unknown section rejected',
        llmResponse: '{"patches":[{"section":"bogus","original":"a","proposed":"b","rationale":"c","supportingTaskIds":["t1"]}]}',
        expected: 'throws',
    },
    {
        name: 'missing proposed field rejected',
        llmResponse: '{"patches":[{"section":"planning","original":"a","rationale":"c","supportingTaskIds":["t1"]}]}',
        expected: 'throws',
    },
    {
        name: 'missing rationale rejected',
        llmResponse: '{"patches":[{"section":"planning","original":"a","proposed":"b","supportingTaskIds":["t1"]}]}',
        expected: 'throws',
    },
    {
        name: 'supportingTaskIds as string (not array) rejected',
        llmResponse: '{"patches":[{"section":"planning","original":"a","proposed":"b","rationale":"c","supportingTaskIds":"t1"}]}',
        expected: 'throws',
    },
    {
        name: 'malformed JSON throws',
        llmResponse: '{"patches":[',
        expected: 'throws',
    },
    {
        name: 'empty string throws',
        llmResponse: '',
        expected: 'throws',
    },
]

// ── Tests ──────────────────────────────────────────────────────────────

describe('prompt-improvement fixture parsing', () => {
    for (const fx of fixtures) {
        it(fx.name, () => {
            if (fx.expected === 'throws') {
                expect(() => parsePatchesResponse(fx.llmResponse)).toThrow()
                return
            }
            const parsed = parsePatchesResponse(fx.llmResponse)
            expect(parsed).toEqual(fx.expected)
            if (fx.expectCount !== undefined) {
                expect(parsed).toHaveLength(fx.expectCount)
            }
        })
    }

    it('fixture count sanity', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(11)
    })
})
