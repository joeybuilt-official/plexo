// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Provider circuit-breaker tests.
 *
 * Verifies the per-(provider, key-hash) breaker that pre-empts withFallback()
 * after N consecutive auth failures, independent of workspaceId — fixes the
 * cron-loop hammering bleed where wsId-scoped staleKeyCache was bypassed.
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

import {
    withFallback,
    clearProviderBreaker,
    _resetProviderBreakerForTest,
    type WorkspaceAISettings,
} from '../registry.js'

const settings = (apiKey = 'sk-bad-deepseek-key'): WorkspaceAISettings => ({
    primaryProvider: 'deepseek',
    fallbackChain: [],
    providers: {
        deepseek: { provider: 'deepseek', apiKey, model: 'deepseek-chat', enabled: true },
    },
})

const authError = (): Error => Object.assign(new Error('401 invalid_api_key'), { statusCode: 401 })

beforeEach(() => {
    _resetProviderBreakerForTest()
})

describe('provider circuit-breaker', () => {
    it('does not trip on first or second auth failure', async () => {
        const fn = vi.fn().mockRejectedValue(authError())
        await expect(withFallback(settings(), 'planning', fn)).rejects.toThrow(/401/)
        await expect(withFallback(settings(), 'planning', fn)).rejects.toThrow(/401/)
        expect(fn).toHaveBeenCalledTimes(2)
    })

    it('trips after 3 consecutive auth failures and short-circuits subsequent calls', async () => {
        const fn = vi.fn().mockRejectedValue(authError())
        for (let i = 0; i < 3; i++) {
            await expect(withFallback(settings(), 'planning', fn)).rejects.toBeDefined()
        }
        expect(fn).toHaveBeenCalledTimes(3)

        await expect(withFallback(settings(), 'planning', fn)).rejects.toThrow(/circuit-open/)
        await expect(withFallback(settings(), 'planning', fn)).rejects.toThrow(/circuit-open/)
        expect(fn).toHaveBeenCalledTimes(3)
    })

    it('emits a single circuit_open event on trip, not on every subsequent call', async () => {
        const fn = vi.fn().mockRejectedValue(authError())
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => { })

        for (let i = 0; i < 6; i++) {
            await expect(withFallback(settings(), 'planning', fn)).rejects.toBeDefined()
        }

        const opens = infoSpy.mock.calls
            .map(c => String(c[0] ?? ''))
            .filter(s => s.includes('"event":"provider.circuit_open"'))
        expect(opens.length).toBe(1)
        infoSpy.mockRestore()
    })

    it('different api keys for the same provider do not share trip state', async () => {
        const fnBad = vi.fn().mockRejectedValue(authError())
        for (let i = 0; i < 3; i++) {
            await expect(withFallback(settings('sk-bad'), 'planning', fnBad)).rejects.toBeDefined()
        }
        await expect(withFallback(settings('sk-bad'), 'planning', fnBad)).rejects.toThrow(/circuit-open/)

        const fnGood = vi.fn().mockResolvedValue('ok')
        await expect(withFallback(settings('sk-fresh'), 'planning', fnGood)).resolves.toBe('ok')
        expect(fnGood).toHaveBeenCalledTimes(1)
    })

    it('clearProviderBreaker resets the trip', async () => {
        const fn = vi.fn().mockRejectedValue(authError())
        for (let i = 0; i < 3; i++) {
            await expect(withFallback(settings(), 'planning', fn)).rejects.toBeDefined()
        }
        await expect(withFallback(settings(), 'planning', fn)).rejects.toThrow(/circuit-open/)

        clearProviderBreaker('deepseek')

        const fnGood = vi.fn().mockResolvedValue('ok')
        await expect(withFallback(settings(), 'planning', fnGood)).resolves.toBe('ok')
    })

    it('does not trip on rate-limit (429) errors', async () => {
        const rateErr = Object.assign(new Error('429 rate limit exceeded'), { statusCode: 429 })
        const fn = vi.fn().mockRejectedValue(rateErr)
        for (let i = 0; i < 5; i++) {
            await expect(withFallback(settings(), 'planning', fn)).rejects.toBeDefined()
        }
        expect(fn).toHaveBeenCalledTimes(5)
    })

    it('does not trip on 5xx errors', async () => {
        const srvErr = Object.assign(new Error('503 service unavailable'), { statusCode: 503 })
        const fn = vi.fn().mockRejectedValue(srvErr)
        for (let i = 0; i < 5; i++) {
            await expect(withFallback(settings(), 'planning', fn)).rejects.toBeDefined()
        }
        expect(fn).toHaveBeenCalledTimes(5)
    })

    it('a successful call resets the consecutive-failure counter', async () => {
        const fnFail = vi.fn().mockRejectedValue(authError())
        const fnOk = vi.fn().mockResolvedValue('ok')

        await expect(withFallback(settings(), 'planning', fnFail)).rejects.toBeDefined()
        await expect(withFallback(settings(), 'planning', fnFail)).rejects.toBeDefined()
        await expect(withFallback(settings(), 'planning', fnOk)).resolves.toBe('ok')

        await expect(withFallback(settings(), 'planning', fnFail)).rejects.toBeDefined()
        await expect(withFallback(settings(), 'planning', fnFail)).rejects.toBeDefined()

        const finalCall = vi.fn().mockResolvedValue('still-ok')
        await expect(withFallback(settings(), 'planning', finalCall)).resolves.toBe('still-ok')
    })
})
