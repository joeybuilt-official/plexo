// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — local-GPU fallback guard.
 *
 * Covers the pure primitives (classifiers, env parsing, token bucket, degraded-
 * peer detection) plus an end-to-end routeAndCall assertion that a broken cloud
 * condition can no longer turn into an unbounded hammer on the local ollama GPU.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
    isLocalProvider,
    isBulkTaskType,
    localFallbackMaxPerMin,
    localFallbackCooldownMs,
    localFallbackGuardEnabled,
    tryConsumeLocalFallback,
    hasFailingCloudPeer,
    _resetLocalGuardForTest,
} from '../local-guard.js'
import { routeAndCall } from '../index.js'
import { recordCooldown, _resetStatsForTest } from '../stats.js'
import type { AvailableProvider } from '../selector.js'
import type { WorkspaceAISettings } from '../../registry.js'

const ap = (provider: string, model?: string): AvailableProvider =>
    ({ provider, config: { provider, model } } as unknown as AvailableProvider)

const settingsWith = (over: Partial<WorkspaceAISettings> = {}): WorkspaceAISettings =>
    ({ providers: {}, primaryProvider: 'ollama', fallbackChain: [], ...over } as unknown as WorkspaceAISettings)

const GUARD_ENVS = [
    'PLEXO_LOCAL_FALLBACK_MAX_PER_MIN',
    'PLEXO_LOCAL_FALLBACK_COOLDOWN_MS',
    'PLEXO_MODEL_ROUTER',
    'PLEXO_AI_LANE_ISOLATION',
    'PLEXO_ROUTER_WARM_START',
]

beforeEach(() => {
    for (const e of GUARD_ENVS) delete process.env[e]
    _resetLocalGuardForTest()
    _resetStatsForTest()
})
afterEach(() => {
    for (const e of GUARD_ENVS) delete process.env[e]
    _resetLocalGuardForTest()
    _resetStatsForTest()
    vi.restoreAllMocks()
})

describe('classifiers', () => {
    it('treats only the local ollama provider as local', () => {
        expect(isLocalProvider('ollama')).toBe(true)
        expect(isLocalProvider('ollama_cloud')).toBe(false)
        expect(isLocalProvider('groq')).toBe(false)
        expect(isLocalProvider('anthropic')).toBe(false)
    })

    it('classifies bulk/background task types', () => {
        for (const t of ['extraction', 'summarization', 'judging', 'logAnalysis'] as const) {
            expect(isBulkTaskType(t)).toBe(true)
        }
        for (const t of ['conversation', 'planning', 'classification', 'codeGeneration', 'verification'] as const) {
            expect(isBulkTaskType(t)).toBe(false)
        }
    })
})

describe('env parsing', () => {
    it('defaults to 6/min and 60s cooldown', () => {
        expect(localFallbackMaxPerMin()).toBe(6)
        expect(localFallbackCooldownMs()).toBe(60_000)
        expect(localFallbackGuardEnabled()).toBe(true)
    })

    it('honors overrides and disables at 0', () => {
        process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN = '3'
        expect(localFallbackMaxPerMin()).toBe(3)
        expect(localFallbackGuardEnabled()).toBe(true)
        process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN = '0'
        expect(localFallbackMaxPerMin()).toBe(0)
        expect(localFallbackGuardEnabled()).toBe(false)
    })

    it('falls back to the default on garbage input', () => {
        process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN = 'not-a-number'
        expect(localFallbackMaxPerMin()).toBe(6)
    })
})

describe('tryConsumeLocalFallback (token bucket)', () => {
    it('allows up to max then denies within the window', () => {
        process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN = '2'
        expect(tryConsumeLocalFallback('ws-1', 'extraction')).toBe(true)
        expect(tryConsumeLocalFallback('ws-1', 'extraction')).toBe(true)
        expect(tryConsumeLocalFallback('ws-1', 'extraction')).toBe(false)
    })

    it('is keyed per (workspace, taskType)', () => {
        process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN = '1'
        expect(tryConsumeLocalFallback('ws-1', 'extraction')).toBe(true)
        expect(tryConsumeLocalFallback('ws-1', 'extraction')).toBe(false)
        // different task type — independent bucket
        expect(tryConsumeLocalFallback('ws-1', 'summarization')).toBe(true)
        // different workspace — independent bucket
        expect(tryConsumeLocalFallback('ws-2', 'extraction')).toBe(true)
    })

    it('never denies when disabled (max=0)', () => {
        process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN = '0'
        for (let i = 0; i < 50; i++) {
            expect(tryConsumeLocalFallback('ws-1', 'extraction')).toBe(true)
        }
    })
})

describe('hasFailingCloudPeer', () => {
    const available = [ap('ollama_cloud', 'gpt-oss:20b-cloud'), ap('ollama', 'gemma3:4b')]

    it('is true when a configured cloud peer is in cooldown', () => {
        recordCooldown(
            { workspaceId: 'ws-1', provider: 'ollama_cloud', model: 'gpt-oss:20b-cloud', taskType: 'extraction' },
            Date.now() + 60_000,
        )
        expect(hasFailingCloudPeer({ workspaceId: 'ws-1', taskType: 'extraction', available, settings: settingsWith() })).toBe(true)
    })

    it('is false when the only non-local peers are healthy', () => {
        expect(hasFailingCloudPeer({ workspaceId: 'ws-1', taskType: 'extraction', available, settings: settingsWith() })).toBe(false)
    })

    it('is false for a local-only workspace (no cloud peer to fail)', () => {
        expect(hasFailingCloudPeer({
            workspaceId: 'ws-1',
            taskType: 'extraction',
            available: [ap('ollama', 'gemma3:4b')],
            settings: settingsWith(),
        })).toBe(false)
    })
})

describe('routeAndCall — local fallback is bounded when the cloud chain is degraded', () => {
    const settings = settingsWith({
        primaryProvider: 'ollama_cloud',
        fallbackChain: ['ollama'],
        providers: {
            ollama_cloud: { provider: 'ollama_cloud', model: 'gpt-oss:20b-cloud', apiKey: 'x' },
            ollama: { provider: 'ollama', model: 'gemma3:4b' },
        },
    } as unknown as Partial<WorkspaceAISettings>)

    it('caps local GPU serves and diverts excess off the local provider', async () => {
        process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN = '2'
        // Cloud peer is failing → local ollama becomes a degraded fallback.
        recordCooldown(
            { workspaceId: 'ws-1', provider: 'ollama_cloud', model: 'gpt-oss:20b-cloud', taskType: 'extraction' },
            Date.now() + 5 * 60_000,
        )
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const served: string[] = []
        const doCall = (model: unknown): Promise<{ ok: true }> => {
            served.push((model as { modelId?: string }).modelId ?? 'unknown')
            return Promise.resolve({ ok: true })
        }

        for (let i = 0; i < 4; i++) {
            await routeAndCall({ workspaceId: 'ws-1', taskType: 'extraction', settings, doCall })
        }

        const localServes = served.filter((m) => m === 'gemma3:4b').length
        // The local GPU is called at most `max` times despite 4 requests.
        expect(localServes).toBe(2)
        // The excess was diverted to the (degraded) cloud peer, not the local GPU.
        expect(served.filter((m) => m === 'gpt-oss:20b-cloud').length).toBe(2)
        // The degraded-mode condition is now VISIBLE (was previously silent).
        // One throttle per cooldown window: the deny cools the local candidate,
        // so the next request prefers the (degraded) cloud peer — the pause.
        const throttleLines = warn.mock.calls.filter((c) =>
            typeof c[0] === 'string' && c[0].includes('router.local_fallback_throttled'))
        expect(throttleLines.length).toBeGreaterThanOrEqual(1)
    })

    it('does not throttle interactive task types (a human is waiting)', async () => {
        process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN = '1'
        recordCooldown(
            { workspaceId: 'ws-1', provider: 'ollama_cloud', model: 'gpt-oss:20b-cloud', taskType: 'conversation' },
            Date.now() + 5 * 60_000,
        )
        const served: string[] = []
        const doCall = (model: unknown): Promise<{ ok: true }> => {
            served.push((model as { modelId?: string }).modelId ?? 'unknown')
            return Promise.resolve({ ok: true })
        }
        for (let i = 0; i < 4; i++) {
            await routeAndCall({ workspaceId: 'ws-1', taskType: 'conversation', settings, doCall })
        }
        // conversation is interactive → local fallback stays unthrottled.
        expect(served.filter((m) => m === 'gemma3:4b').length).toBe(4)
    })

    it('does not throttle when local ollama is the intended primary (no failing cloud peer)', async () => {
        process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN = '1'
        const localOnly = settingsWith({
            primaryProvider: 'ollama',
            fallbackChain: [],
            providers: { ollama: { provider: 'ollama', model: 'gemma3:4b' } },
        } as unknown as Partial<WorkspaceAISettings>)
        const served: string[] = []
        const doCall = (model: unknown): Promise<{ ok: true }> => {
            served.push((model as { modelId?: string }).modelId ?? 'unknown')
            return Promise.resolve({ ok: true })
        }
        for (let i = 0; i < 4; i++) {
            await routeAndCall({ workspaceId: 'ws-1', taskType: 'extraction', settings: localOnly, doCall })
        }
        expect(served.filter((m) => m === 'gemma3:4b').length).toBe(4)
    })
})
