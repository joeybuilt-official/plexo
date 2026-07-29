// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 of intelligence-hardening: fixture tests for the sprint
 * planner LLM response parsing. Production call site:
 *     packages/agent/src/sprint/planner.ts:121-150
 *
 * Two paths:
 *   1. generateObject with SprintPlanSchema directly (structured output)
 *   2. On failure, generateText with JSON instructions → strip fences →
 *      JSON.parse → SprintPlanSchema.parse (fallback path)
 *
 * Both end in the same Zod parse. This test covers the Zod contract.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// ── Schemas — mirror production ───────────────────────────────────────

const SprintTaskSchema = z.object({
    id: z.string(),
    description: z.string(),
    scope: z.array(z.string()),
    acceptance: z.string(),
    branch: z.string(),
    priority: z.number(),
    depends_on: z.array(z.string()),
})

const SprintPlanSchema = z.object({
    tasks: z.array(SprintTaskSchema).max(8),
    parallelism_note: z.string(),
})

type SprintPlan = z.infer<typeof SprintPlanSchema>

function parseSprintPlan(rawText: string): SprintPlan {
    const raw = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    return SprintPlanSchema.parse(JSON.parse(raw))
}

// ── Fixtures ───────────────────────────────────────────────────────────

interface Fixture {
    name: string
    llmResponse: string
    expected: 'throws' | SprintPlan
    expectTaskCount?: number
}

const fixtures: Fixture[] = [
    {
        name: 'single-task sprint',
        llmResponse: '{"tasks":[{"id":"t1","description":"Add health endpoint","scope":["apps/api"],"acceptance":"/health returns 200","branch":"feat/health","priority":1,"depends_on":[]}],"parallelism_note":"single task, no parallelism"}',
        expected: {
            tasks: [{
                id: 't1',
                description: 'Add health endpoint',
                scope: ['apps/api'],
                acceptance: '/health returns 200',
                branch: 'feat/health',
                priority: 1,
                depends_on: [],
            }],
            parallelism_note: 'single task, no parallelism',
        },
        expectTaskCount: 1,
    },
    {
        name: 'three-task sprint with dependencies',
        llmResponse: '{"tasks":[{"id":"t1","description":"Schema","scope":["packages/db"],"acceptance":"migration applies","branch":"feat/schema","priority":1,"depends_on":[]},{"id":"t2","description":"API route","scope":["apps/api"],"acceptance":"route returns data","branch":"feat/api","priority":2,"depends_on":["t1"]},{"id":"t3","description":"UI","scope":["apps/web"],"acceptance":"UI renders","branch":"feat/ui","priority":3,"depends_on":["t2"]}],"parallelism_note":"sequential chain, no parallelism possible"}',
        expected: {
            tasks: [
                { id: 't1', description: 'Schema', scope: ['packages/db'], acceptance: 'migration applies', branch: 'feat/schema', priority: 1, depends_on: [] },
                { id: 't2', description: 'API route', scope: ['apps/api'], acceptance: 'route returns data', branch: 'feat/api', priority: 2, depends_on: ['t1'] },
                { id: 't3', description: 'UI', scope: ['apps/web'], acceptance: 'UI renders', branch: 'feat/ui', priority: 3, depends_on: ['t2'] },
            ],
            parallelism_note: 'sequential chain, no parallelism possible',
        },
        expectTaskCount: 3,
    },
    {
        name: 'markdown-fenced sprint plan',
        llmResponse: '```json\n{"tasks":[{"id":"t1","description":"x","scope":["a"],"acceptance":"y","branch":"b","priority":1,"depends_on":[]}],"parallelism_note":"none"}\n```',
        expected: {
            tasks: [{ id: 't1', description: 'x', scope: ['a'], acceptance: 'y', branch: 'b', priority: 1, depends_on: [] }],
            parallelism_note: 'none',
        },
        expectTaskCount: 1,
    },
    {
        name: 'eight-task sprint (max allowed)',
        llmResponse: `{"tasks":${JSON.stringify(
            Array.from({ length: 8 }, (_, i) => ({
                id: `t${i + 1}`,
                description: `Task ${i + 1}`,
                scope: [`path${i + 1}`],
                acceptance: `criteria ${i + 1}`,
                branch: `feat/t${i + 1}`,
                priority: i + 1,
                depends_on: [] as string[],
            })),
        )},"parallelism_note":"8 tasks, fully parallel"}`,
        expected: {
            tasks: Array.from({ length: 8 }, (_, i) => ({
                id: `t${i + 1}`,
                description: `Task ${i + 1}`,
                scope: [`path${i + 1}`],
                acceptance: `criteria ${i + 1}`,
                branch: `feat/t${i + 1}`,
                priority: i + 1,
                depends_on: [],
            })),
            parallelism_note: '8 tasks, fully parallel',
        },
        expectTaskCount: 8,
    },
    {
        name: 'nine tasks — exceeds max, throws',
        llmResponse: `{"tasks":${JSON.stringify(
            Array.from({ length: 9 }, (_, i) => ({
                id: `t${i + 1}`,
                description: `x`,
                scope: ['a'],
                acceptance: 'y',
                branch: 'b',
                priority: 1,
                depends_on: [] as string[],
            })),
        )},"parallelism_note":"too many"}`,
        expected: 'throws',
    },
    {
        name: 'missing parallelism_note — throws',
        llmResponse: '{"tasks":[{"id":"t1","description":"x","scope":["a"],"acceptance":"y","branch":"b","priority":1,"depends_on":[]}]}',
        expected: 'throws',
    },
    {
        name: 'missing acceptance field in task — throws',
        llmResponse: '{"tasks":[{"id":"t1","description":"x","scope":["a"],"branch":"b","priority":1,"depends_on":[]}],"parallelism_note":"x"}',
        expected: 'throws',
    },
    {
        name: 'priority as string — throws',
        llmResponse: '{"tasks":[{"id":"t1","description":"x","scope":["a"],"acceptance":"y","branch":"b","priority":"high","depends_on":[]}],"parallelism_note":"x"}',
        expected: 'throws',
    },
    {
        name: 'scope as string (not array) — throws',
        llmResponse: '{"tasks":[{"id":"t1","description":"x","scope":"a","acceptance":"y","branch":"b","priority":1,"depends_on":[]}],"parallelism_note":"x"}',
        expected: 'throws',
    },
    {
        name: 'empty tasks array',
        llmResponse: '{"tasks":[],"parallelism_note":"nothing to do"}',
        expected: { tasks: [], parallelism_note: 'nothing to do' },
        expectTaskCount: 0,
    },
    {
        name: 'malformed JSON throws',
        llmResponse: '{"tasks":[',
        expected: 'throws',
    },
    {
        name: 'empty string throws',
        llmResponse: '',
        expected: 'throws',
    },
]

// ── Tests ──────────────────────────────────────────────────────────────

describe('sprint-planner fixture parsing', () => {
    for (const fx of fixtures) {
        it(fx.name, () => {
            if (fx.expected === 'throws') {
                expect(() => parseSprintPlan(fx.llmResponse)).toThrow()
                return
            }
            const parsed = parseSprintPlan(fx.llmResponse)
            expect(parsed).toEqual(fx.expected)
            if (fx.expectTaskCount !== undefined) {
                expect(parsed.tasks).toHaveLength(fx.expectTaskCount)
            }
        })
    }

    it('fixture count sanity', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(11)
    })
})
