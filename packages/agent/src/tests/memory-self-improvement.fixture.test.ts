// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 of intelligence-hardening: fixture tests for the
 * self-improvement LLM response parsing. Production call site:
 *     packages/agent/src/memory/self-improvement.ts:233-255
 *
 *     generateText(...) → strip ```json fences → JSON.parse →
 *     ProposalsSchema.parse(...).proposals
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// ── Schema — mirror production ────────────────────────────────────────

const ImprovementProposalSchema = z.object({
    pattern_type: z.enum([
        'failure_pattern',
        'success_pattern',
        'tool_preference',
        'scope_adjustment',
        'skill_proposal',
        'extension_proposal',
        'plugin_proposal',
        'agent_proposal',
    ]),
    description: z.string(),
    evidence: z.array(z.string()),
    proposed_change: z.string().optional(),
})

const ProposalsSchema = z.object({
    proposals: z.array(ImprovementProposalSchema).max(5).default([]).catch([]),
})

type Proposal = z.infer<typeof ImprovementProposalSchema>

function parseProposalsResponse(rawText: string): Proposal[] {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    return ProposalsSchema.parse(JSON.parse(cleaned)).proposals
}

// ── Fixtures ───────────────────────────────────────────────────────────

interface Fixture {
    name: string
    llmResponse: string
    expected: 'throws' | Proposal[]
    expectCount?: number
}

const fixtures: Fixture[] = [
    {
        name: 'single failure pattern',
        llmResponse: '{"proposals":[{"pattern_type":"failure_pattern","description":"Timeouts on external API","evidence":["task_abc","task_def"]}]}',
        expected: [{ pattern_type: 'failure_pattern', description: 'Timeouts on external API', evidence: ['task_abc', 'task_def'] }],
        expectCount: 1,
    },
    {
        name: 'skill proposal with proposed_change',
        llmResponse: '{"proposals":[{"pattern_type":"skill_proposal","description":"Deploy sequence is repeated 15 times","evidence":["t1","t2","t3"],"proposed_change":"Build a /skills/deploy skill that codifies the sequence"}]}',
        expected: [{
            pattern_type: 'skill_proposal',
            description: 'Deploy sequence is repeated 15 times',
            evidence: ['t1', 't2', 't3'],
            proposed_change: 'Build a /skills/deploy skill that codifies the sequence',
        }],
        expectCount: 1,
    },
    {
        name: 'multiple proposals — tool preference + scope adjustment',
        llmResponse: '{"proposals":[{"pattern_type":"tool_preference","description":"Agent prefers grep over agent explore for small searches","evidence":["t1","t2"]},{"pattern_type":"scope_adjustment","description":"Planner over-plans conversational tasks","evidence":["t5","t6"]}]}',
        expected: [
            { pattern_type: 'tool_preference', description: 'Agent prefers grep over agent explore for small searches', evidence: ['t1', 't2'] },
            { pattern_type: 'scope_adjustment', description: 'Planner over-plans conversational tasks', evidence: ['t5', 't6'] },
        ],
        expectCount: 2,
    },
    {
        name: 'markdown-fenced',
        llmResponse: '```json\n{"proposals":[{"pattern_type":"success_pattern","description":"Fast classify on short messages","evidence":["t1"]}]}\n```',
        expected: [{ pattern_type: 'success_pattern', description: 'Fast classify on short messages', evidence: ['t1'] }],
        expectCount: 1,
    },
    {
        name: 'empty proposals default',
        llmResponse: '{"proposals":[]}',
        expected: [],
        expectCount: 0,
    },
    {
        name: 'missing proposals key — defaults to empty',
        llmResponse: '{}',
        expected: [],
        expectCount: 0,
    },
    {
        name: 'five proposals (max allowed)',
        llmResponse: `{"proposals":[
            {"pattern_type":"failure_pattern","description":"d1","evidence":["e1"]},
            {"pattern_type":"success_pattern","description":"d2","evidence":["e2"]},
            {"pattern_type":"tool_preference","description":"d3","evidence":["e3"]},
            {"pattern_type":"scope_adjustment","description":"d4","evidence":["e4"]},
            {"pattern_type":"plugin_proposal","description":"d5","evidence":["e5"]}
        ]}`,
        expected: [
            { pattern_type: 'failure_pattern', description: 'd1', evidence: ['e1'] },
            { pattern_type: 'success_pattern', description: 'd2', evidence: ['e2'] },
            { pattern_type: 'tool_preference', description: 'd3', evidence: ['e3'] },
            { pattern_type: 'scope_adjustment', description: 'd4', evidence: ['e4'] },
            { pattern_type: 'plugin_proposal', description: 'd5', evidence: ['e5'] },
        ],
        expectCount: 5,
    },
    {
        name: 'six proposals — exceeds max, falls to catch default (empty)',
        llmResponse: `{"proposals":[
            {"pattern_type":"failure_pattern","description":"d1","evidence":["e1"]},
            {"pattern_type":"success_pattern","description":"d2","evidence":["e2"]},
            {"pattern_type":"tool_preference","description":"d3","evidence":["e3"]},
            {"pattern_type":"scope_adjustment","description":"d4","evidence":["e4"]},
            {"pattern_type":"plugin_proposal","description":"d5","evidence":["e5"]},
            {"pattern_type":"agent_proposal","description":"d6","evidence":["e6"]}
        ]}`,
        expected: [],
        expectCount: 0,
    },
    {
        name: 'unknown pattern_type — whole array falls to catch default',
        llmResponse: '{"proposals":[{"pattern_type":"bogus_type","description":"x","evidence":["y"]}]}',
        expected: [],
        expectCount: 0,
    },
    {
        name: 'malformed JSON throws',
        llmResponse: '{"proposals":[',
        expected: 'throws',
    },
    {
        name: 'empty string throws',
        llmResponse: '',
        expected: 'throws',
    },
    {
        name: 'extension proposal type',
        llmResponse: '{"proposals":[{"pattern_type":"extension_proposal","description":"Repeated Stripe checkout flows","evidence":["t1","t2","t3"],"proposed_change":"Ship a Stripe extension"}]}',
        expected: [{
            pattern_type: 'extension_proposal',
            description: 'Repeated Stripe checkout flows',
            evidence: ['t1', 't2', 't3'],
            proposed_change: 'Ship a Stripe extension',
        }],
        expectCount: 1,
    },
]

// ── Tests ──────────────────────────────────────────────────────────────

describe('self-improvement fixture parsing', () => {
    for (const fx of fixtures) {
        it(fx.name, () => {
            if (fx.expected === 'throws') {
                expect(() => parseProposalsResponse(fx.llmResponse)).toThrow()
                return
            }
            const parsed = parseProposalsResponse(fx.llmResponse)
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
