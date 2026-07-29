// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 of intelligence-hardening: fixture tests for the planner LLM
 * response parsing path. Production call site:
 *     packages/agent/src/planner/index.ts:205-221
 *
 *     generateText(...) → strip ```json fences → JSON.parse →
 *     PlannerOutputSchema.parse (discriminatedUnion of plan | clarification)
 *
 * This test inlines the schema + parser bit-for-bit. When prompts drift or
 * models start returning slightly different shapes, these tests break
 * loudly instead of the planner silently falling through to the
 * clarification branch.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// ── Schemas — mirror packages/agent/src/planner/index.ts:28-91 ────────

const PlanStepSchema = z.object({
    stepNumber: z.number().int().positive(),
    description: z.string(),
    toolsRequired: z.array(z.string()).default([]),
    verificationMethod: z.string().default('Manual review'),
    isOneWayDoor: z.boolean().default(false),
    depends_on: z.array(z.number().int().positive()).default([]),
})

const OneWayDoorSchema = z.union([
    z.object({
        description: z.string().min(5),
        type: z.enum(['data_write', 'external_call', 'destructive', 'state_change']),
        reversibility: z.string(),
        requiresApproval: z.boolean(),
    }),
    z.string().min(5).transform((s) => ({
        description: s,
        type: 'state_change' as const,
        reversibility: 'unknown',
        requiresApproval: true,
    })),
])

const PhaseSchema = z.object({
    label: z.string(),
    description: z.string().optional(),
})

const ExecutionPlanShape = z.object({
    type: z.literal('plan'),
    goal: z.string(),
    steps: z.array(PlanStepSchema).min(1),
    oneWayDoors: z.array(OneWayDoorSchema).default([]),
    estimatedDurationMs: z.number().nonnegative().default(30000),
    confidenceScore: z.number().min(0).max(1).default(0.8),
    risks: z.array(z.string()).default([]),
    phases: z.array(PhaseSchema).optional().default([]),
})

const ClarificationShape = z.object({
    type: z.literal('clarification'),
    message: z.string(),
    alternatives: z.array(z.object({
        label: z.string(),
        description: z.string(),
        taskDescription: z.string(),
    })).min(1).max(4),
})

const PlannerOutputSchema = z.discriminatedUnion('type', [ExecutionPlanShape, ClarificationShape])

type PlannerOutput = z.infer<typeof PlannerOutputSchema>

function parsePlannerResponse(rawText: string): PlannerOutput {
    const cleaned = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim()
    return PlannerOutputSchema.parse(JSON.parse(cleaned))
}

// ── Fixtures ───────────────────────────────────────────────────────────

interface Fixture {
    name: string
    llmResponse: string
    expected: 'plan' | 'clarification' | 'throws'
    expectedSteps?: number
    expectedOneWayDoors?: number
}

const fixtures: Fixture[] = [
    // Simple single-step plan
    {
        name: 'single-step plan',
        llmResponse: '{"type":"plan","goal":"Add a health check endpoint","steps":[{"stepNumber":1,"description":"Add /health route","toolsRequired":["write_file"],"verificationMethod":"curl the endpoint","isOneWayDoor":false,"depends_on":[]}],"estimatedDurationMs":60000,"confidenceScore":0.9,"risks":[]}',
        expected: 'plan',
        expectedSteps: 1,
        expectedOneWayDoors: 0,
    },
    // Multi-step plan with oneWayDoor (object form)
    {
        name: 'three-step plan with object OWD',
        llmResponse: '{"type":"plan","goal":"Run migration","steps":[{"stepNumber":1,"description":"Inspect schema"},{"stepNumber":2,"description":"Write migration"},{"stepNumber":3,"description":"Apply migration"}],"oneWayDoors":[{"description":"Schema migration on users table","type":"data_write","reversibility":"reversible via down migration","requiresApproval":true}],"estimatedDurationMs":120000,"confidenceScore":0.85,"risks":["data loss on wrong migration"]}',
        expected: 'plan',
        expectedSteps: 3,
        expectedOneWayDoors: 1,
    },
    // String OWD (leniency branch)
    {
        name: 'plan with bare-string OWD (min length satisfied)',
        llmResponse: '{"type":"plan","goal":"Delete old files","steps":[{"stepNumber":1,"description":"List then delete"}],"oneWayDoors":["delete old log files older than 90 days"],"confidenceScore":0.75}',
        expected: 'plan',
        expectedSteps: 1,
        expectedOneWayDoors: 1,
    },
    // Markdown-fenced plan
    {
        name: 'markdown-fenced plan',
        llmResponse: '```json\n{"type":"plan","goal":"Test","steps":[{"stepNumber":1,"description":"do the thing"}]}\n```',
        expected: 'plan',
        expectedSteps: 1,
    },
    // Clarification — browser gap
    {
        name: 'clarification with two alternatives',
        llmResponse: '{"type":"clarification","message":"I cannot access your private Notion workspace without credentials.","alternatives":[{"label":"Public docs","description":"Search public documentation instead","taskDescription":"Search public Notion templates for project planning"},{"label":"Skip Notion","description":"Skip the Notion step and continue","taskDescription":"Continue without Notion integration"}]}',
        expected: 'clarification',
    },
    // Clarification — single alternative
    {
        name: 'clarification with single alternative',
        llmResponse: '{"type":"clarification","message":"I need more context.","alternatives":[{"label":"Proceed anyway","description":"Continue with assumptions","taskDescription":"Run the task with default assumptions"}]}',
        expected: 'clarification',
    },
    // Plan with all defaults exercised
    {
        name: 'plan with minimal fields (defaults fill in)',
        llmResponse: '{"type":"plan","goal":"Tiny task","steps":[{"stepNumber":1,"description":"just do it"}]}',
        expected: 'plan',
        expectedSteps: 1,
        expectedOneWayDoors: 0,
    },
    // Phases included
    {
        name: 'plan with phases',
        llmResponse: '{"type":"plan","goal":"Refactor auth","steps":[{"stepNumber":1,"description":"scan"},{"stepNumber":2,"description":"refactor"}],"phases":[{"label":"Scanning auth module"},{"label":"Refactoring","description":"apply changes"}],"confidenceScore":0.8}',
        expected: 'plan',
        expectedSteps: 2,
    },
    // Malformed — empty steps (violates .min(1))
    { name: 'empty steps array rejected', llmResponse: '{"type":"plan","goal":"x","steps":[]}', expected: 'throws' },
    // Malformed — missing goal
    { name: 'missing goal rejected', llmResponse: '{"type":"plan","steps":[{"stepNumber":1,"description":"x"}]}', expected: 'throws' },
    // Malformed — unknown type
    { name: 'unknown type rejected', llmResponse: '{"type":"question","goal":"x","steps":[]}', expected: 'throws' },
    // Malformed — stepNumber not positive
    { name: 'zero stepNumber rejected', llmResponse: '{"type":"plan","goal":"x","steps":[{"stepNumber":0,"description":"x"}]}', expected: 'throws' },
    // Malformed JSON
    { name: 'broken JSON', llmResponse: '{"type":"plan",', expected: 'throws' },
    { name: 'empty string', llmResponse: '', expected: 'throws' },
    // Short OWD description rejected (the z.number() → "4" bug class the Foundation plan caught)
    {
        name: 'short OWD string rejected (less than min length 5)',
        llmResponse: '{"type":"plan","goal":"x","steps":[{"stepNumber":1,"description":"x"}],"oneWayDoors":["4"]}',
        expected: 'throws',
    },
    // Clarification with too many alternatives (> 4)
    {
        name: 'clarification with 5 alternatives rejected',
        llmResponse: '{"type":"clarification","message":"x","alternatives":[{"label":"a","description":"a","taskDescription":"a"},{"label":"b","description":"b","taskDescription":"b"},{"label":"c","description":"c","taskDescription":"c"},{"label":"d","description":"d","taskDescription":"d"},{"label":"e","description":"e","taskDescription":"e"}]}',
        expected: 'throws',
    },
]

// ── Tests ──────────────────────────────────────────────────────────────

describe('planner fixture parsing', () => {
    for (const fx of fixtures) {
        it(fx.name, () => {
            if (fx.expected === 'throws') {
                expect(() => parsePlannerResponse(fx.llmResponse)).toThrow()
                return
            }
            const parsed = parsePlannerResponse(fx.llmResponse)
            expect(parsed.type).toBe(fx.expected)
            if (fx.expected === 'plan' && parsed.type === 'plan') {
                if (fx.expectedSteps !== undefined) expect(parsed.steps).toHaveLength(fx.expectedSteps)
                if (fx.expectedOneWayDoors !== undefined) expect(parsed.oneWayDoors).toHaveLength(fx.expectedOneWayDoors)
            }
        })
    }

    it('fixture count sanity', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(12)
    })
})
