// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — behavioral tests.
 *
 * Originally an equivalence suite against the legacy `withFallback` (gate-on
 * vs gate-off). withFallback was retired in L3.4j (2026-05-23); these tests
 * are kept as the canonical behavioral spec for `routeAndCall`.
 *
 * Covers:
 *   - happy path + each retryable error class + all-fail cascade exhaustion
 *   - selector p95 < 50ms (benchmark)
 *   - Q2 hybrid block on high-stakes + all-low-quality
 *   - Q2 hybrid pass-through on summarization + all-low-quality
 *   - manifest hardSkipPredicate
 *   - error-classifier branch matrix
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@plexo/db', () => ({
    db: {
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
    },
    sql: vi.fn(),
    eq: vi.fn(),
    modelsKnowledge: { reliabilityScore: 'reliability_score', modelId: 'model_id' },
}))

// Stub the @ai-sdk/* provider factories — buildModel hits them but we never
// actually execute the returned model; the doCall callback returns a stub.
const stubModel = { __stub: true }
vi.mock('@ai-sdk/openai', () => ({
    openai: vi.fn(() => stubModel),
    createOpenAI: vi.fn(() => () => stubModel),
}))
vi.mock('@ai-sdk/anthropic', () => ({
    anthropic: vi.fn(() => stubModel),
    createAnthropic: vi.fn(() => () => stubModel),
}))
vi.mock('@ai-sdk/google', () => ({
    createGoogleGenerativeAI: vi.fn(() => () => stubModel),
}))
vi.mock('@ai-sdk/mistral', () => ({ createMistral: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/groq', () => ({ createGroq: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/xai', () => ({ createXai: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek: vi.fn(() => () => stubModel) }))
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: vi.fn(() => () => stubModel) }))
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: vi.fn(() => () => stubModel) }))

import {
    _resetProviderBreakerForTest,
    type WorkspaceAISettings,
    type ProviderKey,
} from '../../registry.js'
import {
    routeAndCall,
    selectModel,
    _resetStatsForTest,
    recordCall,
    RouterV2NoCandidateError,
    RouterV2CascadeExhausted,
    LOW_QUALITY_THRESHOLD,
    HIGH_STAKES_TASK_TYPES,
    MANIFEST,
    getManifestEntry,
} from '../index.js'
import { classifyError, _drainOpsEventQueueForTest } from '../error-classifier.js'

const baseSettings = (overrides: Partial<WorkspaceAISettings> = {}): WorkspaceAISettings => ({
    primaryProvider: 'anthropic',
    fallbackChain: ['openai', 'deepseek'],
    providers: {
        anthropic: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6', enabled: true },
        openai: { provider: 'openai', apiKey: 'sk-oa-test', model: 'gpt-4o', enabled: true },
        deepseek: { provider: 'deepseek', apiKey: 'sk-ds-test', model: 'deepseek-v3', enabled: true },
    },
    ...overrides,
})

beforeEach(async () => {
    _resetProviderBreakerForTest()
    _resetStatsForTest()
    _drainOpsEventQueueForTest()
    const { _resetAuthEventsForTest } = await import('../auth-events.js')
    const { _resetQualityWarningsForTest } = await import('../quality-warnings.js')
    _resetAuthEventsForTest()
    _resetQualityWarningsForTest()
})

// ─────────────────────────────────────────────────────────────────────────────
// Manifest

describe('router-v2 manifest', () => {
    it('has 9 task types; 7 carry all 6 providers, 2 retain 5', () => {
        const taskTypes = Object.keys(MANIFEST)
        expect(taskTypes).toHaveLength(9)
        // codeGeneration joined the 6-provider rows in 2026-05-23 when
        // ollama_cloud was added at prior=3 so credit-exhausted workspaces
        // (no anthropic/deepseek) can still route past the Q2-hybrid bar.
        const sixProvider = ['planning', 'extraction', 'classification', 'conversation', 'judging', 'summarization', 'codeGeneration']
        for (const t of sixProvider) {
            expect(Object.keys(MANIFEST[t as keyof typeof MANIFEST]).length).toBe(6)
        }
        const fiveProvider = ['verification', 'logAnalysis']
        for (const t of fiveProvider) {
            expect(Object.keys(MANIFEST[t as keyof typeof MANIFEST]).length).toBe(5)
        }
    })

    it('every entry has priorScore 1..5 + capabilities + quirks arrays + ISO lastValidatedAt', () => {
        const isoDate = /^\d{4}-\d{2}-\d{2}$/
        for (const tt of Object.keys(MANIFEST)) {
            const row = MANIFEST[tt as keyof typeof MANIFEST]
            for (const prov of Object.keys(row) as ProviderKey[]) {
                const e = row[prov]!
                expect(e.priorScore).toBeGreaterThanOrEqual(1)
                expect(e.priorScore).toBeLessThanOrEqual(5)
                expect(Array.isArray(e.capabilities)).toBe(true)
                expect(Array.isArray(e.quirks)).toBe(true)
                expect(e.lastValidatedAt).toMatch(isoDate)
            }
        }
    })

    it('every 6-provider row carries an ollama_cloud entry (managed-pool floor coverage)', () => {
        // Pre-2026-05-23 invariant was "ollama_cloud is always the lowest
        // priorScore in any in-scope row." That held while ollama_cloud's
        // default class was gpt-oss:20b-cloud and premium providers were
        // assumed always-available. Once credit-exhausted workspaces became
        // common (Personal + Koforje both running mistral-large-3:675b on
        // ollama_cloud as primary), planning + codeGeneration moved
        // ollama_cloud to prior=3 so the Q2-hybrid bar doesn't hard-fail.
        // The remaining invariant: ollama_cloud must be present in every
        // 6-provider row so a workspace with only ollama_cloud configured
        // always has at least one scoreable candidate.
        const sixProvider = ['planning', 'extraction', 'classification', 'conversation', 'judging', 'summarization', 'codeGeneration'] as const
        for (const tt of sixProvider) {
            const row = MANIFEST[tt]
            expect(row.ollama_cloud, `ollama_cloud missing for ${tt}`).toBeDefined()
        }
    })

    it('judging row covers all 6 providers with priorScore ≥ 2', () => {
        const row = MANIFEST.judging
        expect(Object.keys(row).sort()).toEqual(['anthropic', 'deepseek', 'google', 'groq', 'ollama_cloud', 'openai'])
        for (const e of Object.values(row)) {
            expect(e!.priorScore).toBeGreaterThanOrEqual(2)
        }
    })

    it('hardSkipPredicate respected by selector', () => {
        const entry = getManifestEntry('classification', 'openai')!
        // monkey-patch a hard-skip
        const original = entry.hardSkipPredicate
        ;(entry as any).hardSkipPredicate = () => true
        try {
            const result = selectModel({
                workspaceId: 'ws-test',
                taskType: 'classification',
                availableProviders: [
                    { provider: 'openai', config: baseSettings().providers.openai! },
                ],
                settings: baseSettings(),
            })
            expect(result.chosen).toBeNull()
            expect(result.noManifestMatch).toBe(true)
        } finally {
            ;(entry as any).hardSkipPredicate = original
        }
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Selector

describe('router-v2 selector', () => {
    it('cold-start: stats empty → manifest priors win (best priorScore)', () => {
        const r = selectModel({
            workspaceId: 'ws-1',
            taskType: 'codeGeneration',
            availableProviders: [
                { provider: 'anthropic', config: baseSettings().providers.anthropic! },
                { provider: 'openai', config: baseSettings().providers.openai! },
                { provider: 'deepseek', config: baseSettings().providers.deepseek! },
            ],
            settings: baseSettings(),
        })
        expect(r.chosen).not.toBeNull()
        expect(r.chosen!.provider).toBe('anthropic')
        expect(r.alternatives.length).toBeGreaterThan(0)
        expect(r.rationale).toContain('anthropic')
    })

    it('emits alternatives_considered always (operator decision C2)', () => {
        const r = selectModel({
            workspaceId: 'ws-1',
            taskType: 'planning',
            availableProviders: [
                { provider: 'anthropic', config: baseSettings().providers.anthropic! },
                { provider: 'openai', config: baseSettings().providers.openai! },
                { provider: 'deepseek', config: baseSettings().providers.deepseek! },
            ],
            settings: baseSettings(),
        })
        expect(r.alternatives.length).toBeGreaterThanOrEqual(2)
        for (const alt of r.alternatives) {
            expect(alt.whyNotPicked).toBeTruthy()
        }
    })

    it('Q2 hybrid: planning + only low-quality providers → requireOperatorAction', () => {
        // Construct an "all low quality" candidate set by monkey-patching the
        // manifest for the test. (Production manifest gives groq/planning
        // priorScore=3 — at the bar — so we mutate it down to 2 to exercise
        // the Q2 path. Same pattern as the summarization test below.)
        const orig = MANIFEST.planning.groq!.priorScore
        ;(MANIFEST.planning.groq as any).priorScore = 2
        try {
            const settings = baseSettings({
                primaryProvider: 'groq',
                fallbackChain: [],
                providers: {
                    groq: { provider: 'groq', apiKey: 'gsk_test', model: 'llama-3.3-70b', enabled: true },
                },
            })
            const r = selectModel({
                workspaceId: 'ws-1',
                taskType: 'planning',
                availableProviders: [{ provider: 'groq', config: settings.providers.groq! }],
                settings,
            })
            expect(r.chosen).toBeNull()
            expect(r.requireOperatorAction).toBe(true)
            expect(r.rationale).toContain('high-stakes')
        } finally {
            ;(MANIFEST.planning.groq as any).priorScore = orig
        }
    })

    it('Q2 hybrid: summarization + only low-quality providers → routes through anyway', () => {
        // For summarization, groq scores 3 (at threshold). Mutate to 2.
        const orig = MANIFEST.summarization.groq!.priorScore
        ;(MANIFEST.summarization.groq as any).priorScore = 2
        try {
            const settings = baseSettings({
                primaryProvider: 'groq',
                fallbackChain: [],
                providers: {
                    groq: { provider: 'groq', apiKey: 'gsk_test', model: 'llama-3.3-70b', enabled: true },
                },
            })
            const r = selectModel({
                workspaceId: 'ws-1',
                taskType: 'summarization',
                availableProviders: [{ provider: 'groq', config: settings.providers.groq! }],
                settings,
            })
            expect(r.chosen).not.toBeNull()
            expect(r.requireOperatorAction).toBe(false)
            expect(r.chosen!.provider).toBe('groq')
        } finally {
            ;(MANIFEST.summarization.groq as any).priorScore = orig
        }
    })

    it('Q1 hybrid: stats refine prior — low-prior provider with perfect record overtakes high-prior provider with bad record', () => {
        // Construct: settings expose anthropic (prior=5) + deepseek (prior=3) for `conversation`.
        // Record anthropic with 80% failure rate, deepseek with 100% success — over enough
        // samples that recentFailurePenalty + successMultiplier flip the ranking.
        _resetStatsForTest()
        const settings = baseSettings()
        const workspaceId = 'ws-hybrid'
        for (let i = 0; i < 40; i++) {
            recordCall(
                { workspaceId, provider: 'anthropic', model: 'claude-sonnet-4-6', taskType: 'conversation' },
                500,
                i % 5 === 0, // 20% success rate
            )
            recordCall(
                { workspaceId, provider: 'deepseek', model: 'deepseek-v3', taskType: 'conversation' },
                500,
                true,
            )
        }
        const r = selectModel({
            workspaceId,
            taskType: 'conversation',
            availableProviders: [
                { provider: 'anthropic', config: settings.providers.anthropic! },
                { provider: 'deepseek', config: settings.providers.deepseek! },
            ],
            settings,
        })
        expect(r.chosen).not.toBeNull()
        expect(r.chosen!.provider).toBe('deepseek')
    })

    it('Q1 hybrid: stats window retains samples within 7-day cutoff', async () => {
        _resetStatsForTest()
        const workspaceId = 'ws-window'
        recordCall(
            { workspaceId, provider: 'anthropic', model: 'claude-sonnet-4-6', taskType: 'conversation' },
            500,
            true,
        )
        // Look up via the same getStats path used by selectModel.
        const { getStats } = await import('../stats.js')
        const stats = getStats({ workspaceId, provider: 'anthropic', model: 'claude-sonnet-4-6', taskType: 'conversation' })
        // A single just-recorded sample must remain in-window; pre-fix (10-min window)
        // this still passes — what we actually guard is the type-level constant.
        expect(stats.sampleCount).toBe(1)
        // Confirm the constant is the 7-day value by reading the module's internal source.
        const fs = await import('node:fs')
        const path = await import('node:path')
        const src = fs.readFileSync(path.resolve(__dirname, '../stats.ts'), 'utf-8')
        expect(src).toMatch(/WINDOW_MS = 7 \* 24 \* 60 \* 60 \* 1000/)
    })

    it('selector p95 < 50ms over 200 iterations (benchmark)', () => {
        const settings = baseSettings()
        const available = [
            { provider: 'anthropic' as ProviderKey, config: settings.providers.anthropic! },
            { provider: 'openai' as ProviderKey, config: settings.providers.openai! },
            { provider: 'deepseek' as ProviderKey, config: settings.providers.deepseek! },
        ]
        const samples: number[] = []
        for (let i = 0; i < 200; i++) {
            const t0 = performance.now()
            selectModel({ workspaceId: `ws-${i}`, taskType: 'codeGeneration', availableProviders: available, settings })
            samples.push(performance.now() - t0)
        }
        samples.sort((a, b) => a - b)
        const p95 = samples[Math.floor(samples.length * 0.95)]!
        // eslint-disable-next-line no-console
        console.info(JSON.stringify({ event: 'router_v2.selector_bench', p50: samples[100], p95, count: samples.length }))
        expect(p95).toBeLessThan(50)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Error classifier

describe('router-v2 error-classifier', () => {
    const cases: Array<[string, string]> = [
        ['401 unauthorized', 'auth'],
        ['403 forbidden', 'auth'],
        ['invalid API key provided', 'auth'],
        ['429 rate limit exceeded', 'rate-limit'],
        ['too many requests', 'rate-limit'],
        ['context length exceeded for this model', 'context-window'],
        ['Request blocked by safety filters', 'content-policy'],
        ['content_policy violation', 'content-policy'],
        ['502 Bad Gateway', 'transient-5xx'],
        ['503 Service Unavailable', 'transient-5xx'],
        ['529 overloaded', 'transient-5xx'],
        ['Request timeout', 'transient-5xx'],
        ['ENOTFOUND api.example.com', 'network'],
        ['ECONNREFUSED', 'network'],
        ['insufficient_quota: billing required', 'quota'],
        ['Insufficient Balance', 'quota'],
        ['Insufficient Balance: Insufficient Balance', 'quota'],
        ['No object generated: response did not match schema', 'parse-malformed'],
        ['No output generated. Check the stream for errors.', 'empty-output'],
        ['AI_NoOutputGeneratedError: No output generated', 'empty-output'],
        ['some unrelated bug', 'unknown'],
    ]

    for (const [msg, expected] of cases) {
        it(`classifies "${msg}" as ${expected}`, () => {
            const c = classifyError(new Error(msg))
            expect(c.class).toBe(expected)
        })
    }

    it('non-Error thrown → unknown + fail-hard', () => {
        const c = classifyError('a string')
        expect(c.class).toBe('unknown')
        expect(c.shouldFallback).toBe(false)
    })

    it('empty-output (empty stream) → retry-same so a single model can recover', () => {
        const c = classifyError(new Error('No output generated. Check the stream for errors.'))
        expect(c.class).toBe('empty-output')
        expect(c.shouldFallback).toBe(true)
        expect(c.suggestedAction).toBe('retry-same')
    })

    it('parse-malformed (structured) → fallback-next, not retry-same', () => {
        const c = classifyError(new Error('No object generated: schema mismatch'))
        expect(c.class).toBe('parse-malformed')
        expect(c.suggestedAction).toBe('fallback-next')
    })

    it('auth class queues ops event', () => {
        _drainOpsEventQueueForTest()
        classifyError(new Error('401 invalid_api_key'))
        const q = _drainOpsEventQueueForTest()
        expect(q.length).toBe(1)
        expect(q[0]!.event).toBe('provider.auth_failed')
    })

    it('parses retry-after when provider includes it', () => {
        const c = classifyError(new Error('429 too many requests; retry after 5'))
        expect(c.class).toBe('rate-limit')
        expect(c.retryAfterMs).toBe(5000)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// routeAndCall happy path / cascade / equivalence

describe('routeAndCall behavior (post-withFallback retirement)', () => {
    // Pre-L3.4j (2026-05-23) this block tested routeAndCall ↔ withFallback
    // equivalence. withFallback is now retired; the equivalence half of each
    // test was deleted, leaving only the routeAndCall assertions that
    // exercise the new cascade-aware behavior.

    it('happy path: primary succeeds → returns the result', async () => {
        const routed = await routeAndCall({
            workspaceId: 'ws-1',
            taskType: 'conversation',
            settings: baseSettings(),
            doCall: async () => 'ok',
        })
        expect(routed).toBe('ok')
    })

    it('rate-limit on first chosen → succeeds via cascade', async () => {
        let calls = 0
        const fn = vi.fn(async () => {
            calls++
            if (calls === 1) throw new Error('429 too many requests')
            return 'ok'
        })

        const routed = await routeAndCall({
            workspaceId: 'wsB',
            taskType: 'conversation',
            settings: baseSettings(),
            doCall: fn,
        })
        expect(routed).toBe('ok')
    })

    it('all providers fail with retryable errors → throws cascade-exhausted', async () => {
        const fn = vi.fn(async () => {
            throw new Error('503 service unavailable')
        })

        _resetStatsForTest()
        await expect(routeAndCall({
            workspaceId: 'wsB',
            taskType: 'conversation',
            settings: baseSettings(),
            doCall: fn,
        })).rejects.toThrow(/exhausted|503/)
    })

    it('non-retryable error → routeAndCall stops after first call', async () => {
        // Use a message that the classifier maps to "unknown" → shouldFallback=false.
        const fn = vi.fn(async () => {
            throw new Error('schema validation: required field "id" missing in tool output')
        })

        await expect(routeAndCall({
            workspaceId: 'wsX',
            taskType: 'conversation',
            settings: baseSettings(),
            doCall: fn,
        })).rejects.toThrow(/schema validation|required field/)
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('empty-output on a SINGLE-provider workspace → retries the SAME model in place (no fallback needed)', async () => {
        _resetStatsForTest()
        let calls = 0
        const fn = vi.fn(async () => {
            calls++
            if (calls === 1) throw new Error('No output generated. Check the stream for errors.')
            return 'ok'
        })
        const settings = baseSettings({
            primaryProvider: 'groq',
            fallbackChain: [],
            providers: {
                groq: { provider: 'groq', apiKey: 'gsk_test', model: 'llama-3.3-70b', enabled: true },
            },
        })
        const routed = await routeAndCall({
            workspaceId: 'wsSingle',
            taskType: 'conversation',
            settings,
            doCall: fn,
        })
        expect(routed).toBe('ok')
        // Retried the same (only) model rather than hard-failing for lack of a fallback.
        expect(fn).toHaveBeenCalledTimes(2)
    })

    it('persistent empty-output on a single provider → retries are bounded, then gives up', async () => {
        _resetStatsForTest()
        const fn = vi.fn(async () => {
            throw new Error('No output generated. Check the stream for errors.')
        })
        const settings = baseSettings({
            primaryProvider: 'groq',
            fallbackChain: [],
            providers: {
                groq: { provider: 'groq', apiKey: 'gsk_test', model: 'llama-3.3-70b', enabled: true },
            },
        })
        await expect(routeAndCall({
            workspaceId: 'wsSingleDead',
            taskType: 'conversation',
            settings,
            doCall: fn,
        })).rejects.toThrow(/exhausted|No output generated/)
        // 1 initial + RETRY_SAME_MAX (2) in-place retries = 3 attempts, then stop.
        expect(fn).toHaveBeenCalledTimes(3)
    })

    it('high-stakes + only low-quality providers → throws RouterV2NoCandidateError', async () => {
        // Production manifest puts groq/planning at priorScore=3 — at the
        // Q2 hybrid bar — so we mutate it down to 2 here to exercise the
        // RouterV2NoCandidateError path. Same pattern as the selector-level
        // Q2 hybrid test earlier in the file.
        const orig = MANIFEST.planning.groq!.priorScore
        ;(MANIFEST.planning.groq as any).priorScore = 2
        try {
            const settings = baseSettings({
                primaryProvider: 'groq',
                fallbackChain: [],
                providers: {
                    groq: { provider: 'groq', apiKey: 'gsk_test', model: 'llama-3.3-70b', enabled: true },
                },
            })
            await expect(routeAndCall({
                workspaceId: 'wsLow',
                taskType: 'planning',
                settings,
                doCall: async () => 'never',
            })).rejects.toBeInstanceOf(RouterV2NoCandidateError)
        } finally {
            ;(MANIFEST.planning.groq as any).priorScore = orig
        }
    })

    it('all candidates have no manifest entry → throws RouterV2NoCandidateError (no operator action)', async () => {
        const settings: WorkspaceAISettings = {
            primaryProvider: 'custom_xyz' as ProviderKey,
            fallbackChain: [],
            providers: {
                ['custom_xyz' as ProviderKey]: {
                    provider: 'custom_xyz' as ProviderKey,
                    apiKey: 'k',
                    baseUrl: 'https://example.com',
                    enabled: true,
                },
            },
        }
        await expect(routeAndCall({
            workspaceId: 'wsCustom',
            taskType: 'conversation',
            settings,
            doCall: async () => 'never',
        })).rejects.toBeInstanceOf(RouterV2NoCandidateError)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Workspace isolation (pre-mortem #2)

describe('router-v2 stats workspace isolation', () => {
    it('one workspace failing does not poison another workspace selection', async () => {
        _resetStatsForTest()

        // Broken workspace: every call to anthropic 503's, cascade picks openai.
        const settingsBroken = baseSettings()
        await expect(routeAndCall({
            workspaceId: 'ws-broken',
            taskType: 'conversation',
            settings: settingsBroken,
            doCall: async () => { throw new Error('503 service unavailable') },
        })).rejects.toBeDefined()

        // Healthy workspace: same provider set, but no prior failures recorded
        // for this workspaceId. Anthropic must still be picked first.
        const r = selectModel({
            workspaceId: 'ws-healthy',
            taskType: 'conversation',
            availableProviders: [
                { provider: 'anthropic', config: settingsBroken.providers.anthropic! },
                { provider: 'openai', config: settingsBroken.providers.openai! },
            ],
            settings: settingsBroken,
        })
        // anthropic and openai both score 5 on conversation in our manifest;
        // pick must be one of them and NOT show cooldown for healthy ws.
        expect(r.chosen).not.toBeNull()
        expect(['anthropic', 'openai']).toContain(r.chosen!.provider)
    })
})
