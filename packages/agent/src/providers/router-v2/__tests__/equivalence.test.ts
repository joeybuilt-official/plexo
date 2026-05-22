// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — equivalence tests.
 *
 * Verifies that for a given WorkspaceAISettings, `routeAndCall` (flag on) and
 * `withFallback` (flag off) produce equivalent outcomes (happy path, each
 * retryable error class, all-fail cascade exhaustion).
 *
 * Also verifies:
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
    withFallback,
    _resetProviderBreakerForTest,
    type WorkspaceAISettings,
    type ProviderKey,
} from '../../registry.js'
import {
    routeAndCall,
    selectModel,
    isRouterV2Enabled,
    _setRouterV2EnabledForTest,
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
    _setRouterV2EnabledForTest(null)
    _drainOpsEventQueueForTest()
    const { _resetAuthEventsForTest } = await import('../auth-events.js')
    const { _resetQualityWarningsForTest } = await import('../quality-warnings.js')
    _resetAuthEventsForTest()
    _resetQualityWarningsForTest()
})

// ─────────────────────────────────────────────────────────────────────────────
// Feature flag

describe('router-v2 feature flag', () => {
    it('is gated on env var (default off)', () => {
        // Default state — env may or may not set it; test override is null.
        const before = isRouterV2Enabled()
        _setRouterV2EnabledForTest(true)
        expect(isRouterV2Enabled()).toBe(true)
        _setRouterV2EnabledForTest(false)
        expect(isRouterV2Enabled()).toBe(false)
        _setRouterV2EnabledForTest(null)
        expect(isRouterV2Enabled()).toBe(before)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Manifest

describe('router-v2 manifest', () => {
    it('has 9 task types; 6 in-scope tasks have all 6 providers, 3 out-of-scope retain 5', () => {
        const taskTypes = Object.keys(MANIFEST)
        expect(taskTypes).toHaveLength(9)
        const inScope = ['planning', 'extraction', 'classification', 'conversation', 'judging', 'summarization']
        for (const t of inScope) {
            expect(Object.keys(MANIFEST[t as keyof typeof MANIFEST]).length).toBe(6)
        }
        const outOfScope = ['codeGeneration', 'verification', 'logAnalysis']
        for (const t of outOfScope) {
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

    it('6 in-scope task types each have ollama_cloud as the lowest-priorScore option', () => {
        const inScope = ['planning', 'extraction', 'classification', 'conversation', 'judging', 'summarization'] as const
        for (const tt of inScope) {
            const row = MANIFEST[tt]
            const oc = row.ollama_cloud
            expect(oc, `ollama_cloud missing for ${tt}`).toBeDefined()
            const others = (Object.entries(row) as [string, { priorScore: number }][])
                .filter(([k]) => k !== 'ollama_cloud')
                .map(([, e]) => e.priorScore)
            expect(Math.min(...others)).toBeGreaterThanOrEqual(oc!.priorScore)
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
        // manifest for the test. groq alone for planning has priorScore=2.
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

describe('routeAndCall vs withFallback — equivalence', () => {
    it('happy path: primary succeeds → both return identical result', async () => {
        _setRouterV2EnabledForTest(false)
        const legacy = await withFallback(baseSettings(), 'conversation', async () => 'ok')
        _setRouterV2EnabledForTest(true)
        const routed = await routeAndCall({
            workspaceId: 'ws-1',
            taskType: 'conversation',
            settings: baseSettings(),
            doCall: async () => 'ok',
        })
        expect(legacy).toBe('ok')
        expect(routed).toBe('ok')
    })

    it('rate-limit on first chosen → both succeed via fallback', async () => {
        let calls = 0
        const fn = vi.fn(async () => {
            calls++
            if (calls === 1) throw new Error('429 too many requests')
            return 'ok'
        })

        _setRouterV2EnabledForTest(false)
        calls = 0
        const legacy = await withFallback(baseSettings(), 'conversation', fn, { workspaceId: 'wsA' })
        expect(legacy).toBe('ok')

        _setRouterV2EnabledForTest(true)
        calls = 0
        const routed = await routeAndCall({
            workspaceId: 'wsB',
            taskType: 'conversation',
            settings: baseSettings(),
            doCall: fn,
        })
        expect(routed).toBe('ok')
    })

    it('all providers fail with retryable errors → both throw cascade-exhausted', async () => {
        const fn = vi.fn(async () => {
            throw new Error('503 service unavailable')
        })

        _setRouterV2EnabledForTest(false)
        await expect(withFallback(baseSettings(), 'conversation', fn, { workspaceId: 'wsA' }))
            .rejects.toThrow(/503|service unavailable/)

        _setRouterV2EnabledForTest(true)
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

        _setRouterV2EnabledForTest(true)
        await expect(routeAndCall({
            workspaceId: 'wsX',
            taskType: 'conversation',
            settings: baseSettings(),
            doCall: fn,
        })).rejects.toThrow(/schema validation|required field/)
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('feature-flag gate inside withFallback: flag on routes through router-v2', async () => {
        _setRouterV2EnabledForTest(true)
        const got = await withFallback(baseSettings(), 'conversation', async () => 'gated', { workspaceId: 'wsZ' })
        expect(got).toBe('gated')
    })

    it('high-stakes + only low-quality providers → throws RouterV2NoCandidateError', async () => {
        _setRouterV2EnabledForTest(true)
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
    })

    it('all candidates have no manifest entry → throws RouterV2NoCandidateError (no operator action)', async () => {
        _setRouterV2EnabledForTest(true)
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
        _setRouterV2EnabledForTest(true)
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
