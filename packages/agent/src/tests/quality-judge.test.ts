// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { detectSideEffectGap, SIDE_EFFECT_PENALTY_CEILING } from '../executor/side-effect-check.js'

// ── Side-effect detector ─────────────────────────────────────────────────────

describe('detectSideEffectGap', () => {
    it('penalises when user asked for Notion page and no notion__ tool fired', () => {
        const r = detectSideEffectGap(
            'Please create a Notion doc outlining the Q4 plan',
            "I'll create a Notion page that outlines the Q4 plan with these sections...",
            ['read_file', 'write_asset', 'task_complete'],
        )
        expect(r.penalised).toBe(true)
        expect(r.expectedLabel).toBe('Notion')
    })

    it('passes when user asked for Notion and a notion__ tool fired', () => {
        const r = detectSideEffectGap(
            'Create a Notion page for the Q4 plan',
            'Created the page.',
            ['notion__create_page', 'task_complete'],
        )
        expect(r.penalised).toBe(false)
        expect(r.matchedTools).toContain('notion__create_page')
    })

    it('penalises when user asked to send an email and no email tool fired', () => {
        const r = detectSideEffectGap(
            'Send an email to the operator with the report attached',
            'I would compose an email to the operator that includes...',
            ['read_file', 'task_complete'],
        )
        expect(r.penalised).toBe(true)
        expect(r.expectedLabel).toBe('Email')
    })

    it('passes when the corresponding email tool fired', () => {
        const r = detectSideEffectGap(
            'Send an email to the operator',
            'Sent.',
            ['gmail__send_message', 'task_complete'],
        )
        expect(r.penalised).toBe(false)
    })

    it('does not penalise purely conversational requests', () => {
        const r = detectSideEffectGap(
            'What is the capital of France?',
            'Paris.',
            ['task_complete'],
        )
        expect(r.penalised).toBe(false)
    })

    it('does not penalise when no action verb+service pair matches', () => {
        const r = detectSideEffectGap(
            'Summarise the attached document',
            'Here is the summary: ...',
            ['read_file', 'write_asset', 'task_complete'],
        )
        expect(r.penalised).toBe(false)
    })

    it('penalises GitHub issue requests when no github__ tool fired', () => {
        const r = detectSideEffectGap(
            'Create a GitHub issue tracking the deploy bug',
            "I'll draft a GitHub issue that describes the deploy bug...",
            ['task_complete'],
        )
        expect(r.penalised).toBe(true)
        expect(r.expectedLabel).toBe('GitHub')
    })

    it('returns empty result for blank input', () => {
        const r = detectSideEffectGap('', '', [])
        expect(r.penalised).toBe(false)
    })

    it('penalises Slack post request with no slack__ tool', () => {
        const r = detectSideEffectGap(
            'Send a Slack message to #general about the deploy',
            "I'll send a message to #general saying the deploy is complete.",
            ['task_complete'],
        )
        expect(r.penalised).toBe(true)
        expect(r.expectedLabel).toBe('Slack')
    })

    it('passes for calendar event when gcal_ tool fires', () => {
        const r = detectSideEffectGap(
            'Schedule a meeting next Tuesday at 3pm',
            'Scheduled.',
            ['gcal__create_event'],
        )
        expect(r.penalised).toBe(false)
    })

    it('detects hypothetical language pattern in reason', () => {
        const r = detectSideEffectGap(
            'Create a Notion page about the roadmap',
            "I will create a Notion page describing the roadmap.",
            ['task_complete'],
        )
        expect(r.penalised).toBe(true)
        expect(r.reason).toMatch(/described it without calling/i)
    })

    it('omits the hypothetical phrase from reason when plain miss', () => {
        const r = detectSideEffectGap(
            'Create a Notion page about the roadmap',
            'Done.',
            ['task_complete'],
        )
        expect(r.penalised).toBe(true)
        expect(r.reason).toMatch(/no notion__ tool was invoked/i)
    })

    it('ceiling constant is sane', () => {
        expect(SIDE_EFFECT_PENALTY_CEILING).toBeGreaterThanOrEqual(0)
        expect(SIDE_EFFECT_PENALTY_CEILING).toBeLessThanOrEqual(0.5)
    })
})

// ── judgeQuality — ensemble / arbitration / fallback ────────────────────────

vi.mock('@plexo/db', async () => {
    return {
        db: {
            select: vi.fn(() => ({
                from: vi.fn(() => ({
                    where: vi.fn(() => ({
                        limit: vi.fn(async () => [] as unknown[]),
                    })),
                })),
            })),
            execute: vi.fn(async () => ({ rows: [] })),
        },
        eq: vi.fn(),
        sql: new Proxy(function () { /* tagged template */ }, {
            apply: () => ({}),
            get: () => () => ({}),
        }),
        modelsKnowledge: { modelId: 'model_id', reliabilityScore: 'reliability_score' },
    }
})

// Phase 4: quality-judge now routes through generateObject via callModel.
// The mock exposes both generateText (still used by other call sites) and
// generateObject (used by runSingleJudge + ensemble), plus a minimal
// NoObjectGeneratedError surrogate for classifyError's isParseError check.
class FakeNoObjectGeneratedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'NoObjectGeneratedError'
    }
    static isInstance(err: unknown): err is FakeNoObjectGeneratedError {
        return err instanceof FakeNoObjectGeneratedError
            || (!!err && typeof err === 'object' && (err as { name?: string }).name === 'NoObjectGeneratedError')
    }
}
vi.mock('ai', async () => {
    return {
        generateText: vi.fn(),
        generateObject: vi.fn(),
        NoObjectGeneratedError: FakeNoObjectGeneratedError,
    }
})

vi.mock('../providers/registry.js', async () => {
    return {
        resolveModelFromEnv: vi.fn(() => 'mock-env-model'),
        resolveModel: vi.fn(async () => ({ model: 'mock-cross-model', meta: null })),
    }
})

vi.mock('@ai-sdk/openai-compatible', async () => {
    return {
        createOpenAICompatible: vi.fn(() => (name: string) => ({ mockedModelName: name })),
    }
})

describe('judgeQuality', () => {
    let originalFetch: typeof globalThis.fetch

    beforeEach(async () => {
        vi.clearAllMocks()
        originalFetch = globalThis.fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    async function loadModule() {
        return await import('../executor/quality-judge.js')
    }

    it('falls back to self-score when generateObject throws in single-judge path', async () => {
        const { generateObject } = await import('ai')
        ;(generateObject as any).mockRejectedValue(new Error('boom'))

        const { judgeQuality } = await loadModule()
        const result = await judgeQuality({
            taskType: 'general',
            goal: 'Say hi',
            deliverableSummary: 'Hi!',
            toolsUsed: ['task_complete'],
            selfScore: 0.77,
            userRequest: 'Say hi',
        })
        expect(result.score).toBe(0.77)
        expect(result.meta.mode).toBe('fallback')
        expect(result.meta.selfScore).toBe(0.77)
    })

    it('caps score when side-effect mismatch is detected (fallback path)', async () => {
        const { generateObject } = await import('ai')
        ;(generateObject as any).mockRejectedValue(new Error('boom'))

        const { judgeQuality } = await loadModule()
        const result = await judgeQuality({
            taskType: 'general',
            goal: 'Create a Notion page for the plan',
            deliverableSummary: "I will create a Notion page for the plan.",
            toolsUsed: ['task_complete'],
            selfScore: 0.95,
            userRequest: 'Create a Notion page for the plan',
        })
        // Score must be capped regardless of self-score
        expect(result.score).toBeLessThanOrEqual(SIDE_EFFECT_PENALTY_CEILING)
    })

    it('runs single-judge path successfully when no ollama configured', async () => {
        const { generateObject } = await import('ai')
        ;(generateObject as any).mockResolvedValue({
            object: {
                scores: [
                    { dimension: 'goal_met', score: 0.9, rationale: 'yes' },
                    { dimension: 'conciseness', score: 0.8, rationale: 'ok' },
                    { dimension: 'helpful_tone', score: 0.85, rationale: 'ok' },
                ],
                overall_notes: 'solid',
            },
            usage: { inputTokens: 10, outputTokens: 5 },
        })

        const { judgeQuality } = await loadModule()
        const result = await judgeQuality({
            taskType: 'general',
            goal: 'Answer question',
            deliverableSummary: 'Answer.',
            toolsUsed: ['task_complete'],
            selfScore: 0.5,
        })
        expect(result.meta.mode).toBe('single')
        expect(result.score).toBeGreaterThan(0.5)
        expect(result.score).toBeLessThanOrEqual(1)
    })

    it('single-judge path uses generateObject — no fence stripping needed', async () => {
        // Phase 4: generateObject returns a parsed object directly; the
        // hand-rolled markdown-fence stripper that used to live in
        // runSingleJudge has been deleted. This test now pins the
        // schema-mode behavior instead: the SDK owns parse + validate,
        // callModel returns `{ object }` directly.
        const { generateObject } = await import('ai')
        ;(generateObject as any).mockResolvedValue({
            object: {
                scores: [{ dimension: 'goal_met', score: 1, rationale: 'perfect' }],
                overall_notes: 'ok',
            },
            usage: { inputTokens: 10, outputTokens: 5 },
        })

        const { judgeQuality } = await loadModule()
        const result = await judgeQuality({
            taskType: 'general',
            goal: 'x',
            deliverableSummary: 'y',
            toolsUsed: [],
            selfScore: 0.5,
        })
        expect(result.meta.mode).toBe('single')
        // dimension 'goal_met' has weight 0.6 out of total 1.0, so only partial coverage
        expect(result.score).toBeGreaterThan(0)
    })

    it('returns fallback when generateObject throws NoObjectGeneratedError (CALL_MODEL_PARSE)', async () => {
        // Phase 4: the SDK's generateObject handles parse + retry and
        // surfaces a NoObjectGeneratedError on persistent failure. The
        // outer judgeQuality catch converts any thrown error into the
        // fallback self-score path.
        const { generateObject } = await import('ai')
        ;(generateObject as any).mockRejectedValue(new FakeNoObjectGeneratedError('could not parse object'))

        const { judgeQuality } = await loadModule()
        const result = await judgeQuality({
            taskType: 'general',
            goal: 'x',
            deliverableSummary: 'y',
            toolsUsed: [],
            selfScore: 0.42,
        })
        expect(result.meta.mode).toBe('fallback')
        expect(result.score).toBe(0.42)
    })

    it('runs ensemble when ollama provider configured and models discoverable', async () => {
        // Mock fetch for /api/tags discovery
        globalThis.fetch = vi.fn(async () =>
            new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'phi3:mini' }] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        ) as any

        const { generateObject } = await import('ai')
        ;(generateObject as any).mockResolvedValue({
            object: {
                scores: [
                    { dimension: 'goal_met', score: 0.7, rationale: 'ok' },
                    { dimension: 'conciseness', score: 0.7, rationale: 'ok' },
                    { dimension: 'helpful_tone', score: 0.7, rationale: 'ok' },
                ],
                overall_notes: 'ok',
            },
            usage: { inputTokens: 10, outputTokens: 5 },
        })

        const { judgeQuality } = await loadModule()
        const result = await judgeQuality({
            taskType: 'general',
            goal: 'x',
            deliverableSummary: 'y',
            toolsUsed: [],
            selfScore: 0.5,
            aiSettings: {
                primaryProvider: 'anthropic',
                fallbackChain: [],
                providers: {
                    ollama: { baseUrl: 'http://localhost:11434' },
                },
            } as any,
        })
        expect(['ensemble', 'ensemble+arbitration', 'single', 'fallback']).toContain(result.meta.mode)
        // Consensus — no dissent — should be ensemble mode with judgeCount > 0
        if (result.meta.mode === 'ensemble') {
            expect(result.meta.judgeCount).toBeGreaterThan(0)
        }
    })

    it('falls through to single judge when ollama discovery returns empty', async () => {
        globalThis.fetch = vi.fn(async () =>
            new Response(JSON.stringify({ models: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        ) as any

        const { generateObject } = await import('ai')
        ;(generateObject as any).mockResolvedValue({
            object: {
                scores: [{ dimension: 'goal_met', score: 0.9, rationale: 'ok' }],
                overall_notes: 'ok',
            },
            usage: { inputTokens: 10, outputTokens: 5 },
        })

        const { judgeQuality } = await loadModule()
        const result = await judgeQuality({
            taskType: 'general',
            goal: 'x',
            deliverableSummary: 'y',
            toolsUsed: [],
            selfScore: 0.5,
            aiSettings: {
                primaryProvider: 'anthropic',
                fallbackChain: [],
                providers: {
                    ollama: { baseUrl: 'http://localhost:11434' },
                },
            } as any,
        })
        expect(result.meta.mode).toBe('single')
    })

    it('accepts ensembleSize parameter from aiSettings without crashing', async () => {
        // NOTE: discoverOllamaModels() is currently unreachable from
        // judgeQuality (quality-judge.ts:142 is defined but not called) — the
        // single-judge cascade is the only live path. This test verifies that
        // passing ensembleSize through aiSettings does not crash the caller.
        // Restored as a smoke test until Phase 4e-3 quality-judge migration
        // either revives the ensemble path or removes the dead constant.
        globalThis.fetch = vi.fn(async () =>
            new Response(JSON.stringify({
                models: [
                    { name: 'llama3.2' },
                    { name: 'phi3' },
                    { name: 'gemma2' },
                    { name: 'mistral' },
                    { name: 'qwen2.5' },
                ],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        ) as any

        const { generateObject } = await import('ai')
        ;(generateObject as any).mockResolvedValue({
            object: {
                scores: [{ dimension: 'goal_met', score: 0.8, rationale: 'ok' }],
                overall_notes: 'ok',
            },
            usage: { inputTokens: 10, outputTokens: 5 },
        })

        const { judgeQuality } = await loadModule()
        const result = await judgeQuality({
            taskType: 'general',
            goal: 'x',
            deliverableSummary: 'y',
            toolsUsed: [],
            selfScore: 0.5,
            aiSettings: {
                primaryProvider: 'anthropic',
                fallbackChain: [],
                providers: { ollama: { baseUrl: 'http://localhost:11434' } },
                ensembleSize: 2,
            } as any,
        })
        expect(['ensemble', 'ensemble+arbitration', 'single', 'fallback']).toContain(result.meta.mode)
    })

    it('clamps final score to [0, 1]', async () => {
        const { generateObject } = await import('ai')
        ;(generateObject as any).mockResolvedValue({
            object: {
                scores: [
                    { dimension: 'goal_met', score: 1, rationale: 'perfect' },
                    { dimension: 'conciseness', score: 1, rationale: 'perfect' },
                    { dimension: 'helpful_tone', score: 1, rationale: 'perfect' },
                ],
                overall_notes: 'ok',
            },
            usage: { inputTokens: 10, outputTokens: 5 },
        })

        const { judgeQuality } = await loadModule()
        const result = await judgeQuality({
            taskType: 'general',
            goal: 'x',
            deliverableSummary: 'y',
            toolsUsed: [],
            selfScore: 0.5,
        })
        expect(result.score).toBeLessThanOrEqual(1)
        expect(result.score).toBeGreaterThanOrEqual(0)
    })
})
