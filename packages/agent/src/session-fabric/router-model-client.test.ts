// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WorkspaceAISettings } from '../providers/registry.js'

const routeAndCall = vi.fn()
const callModel = vi.fn()
const buildModel = vi.fn()
const resolveModelFromEnv = vi.fn()

vi.mock('../providers/router-v2/index.js', () => ({
    routeAndCall: (input: unknown) => routeAndCall(input),
}))
vi.mock('../providers/call-model.js', () => ({
    callModel: (opts: unknown) => callModel(opts),
}))
vi.mock('../providers/registry.js', () => ({
    buildModel: (...args: unknown[]) => buildModel(...args),
    // Provider-agnostic hard floor (feedback_no_hardwired_llm_provider): the
    // exhaustion path dynamically imports resolveModelFromEnv, not anthropic.
    resolveModelFromEnv: () => resolveModelFromEnv(),
}))

// Import AFTER the mocks are registered.
const { routerModelClient } = await import('./router-model-client.js')

const FAKE_MODEL = { id: 'fake' } as never
const ENV_MODEL = { id: 'env' } as never

beforeEach(() => {
    routeAndCall.mockReset()
    callModel.mockReset()
    buildModel.mockReset()
    resolveModelFromEnv.mockReset()
})

const PINNED_MODEL = { id: 'pinned' } as never

function pinnedSettings(): WorkspaceAISettings {
    return {
        primaryProvider: 'openai',
        fallbackChain: [],
        providers: { openai: { provider: 'openai', apiKey: 'sk-1', baseUrl: 'https://oai.example' } },
        judgeModel: { provider: 'openai', model: 'gpt-4o-mini' },
    }
}

describe('routerModelClient', () => {
    it('maps {system,user} -> callModel {system,prompt} and returns .text', async () => {
        // Real degrade lives in routeAndCall; here we drive its doCall to prove wiring.
        routeAndCall.mockImplementation(async (input: { doCall: (m: unknown) => Promise<string> }) =>
            input.doCall(FAKE_MODEL),
        )
        callModel.mockResolvedValue({ text: 'PLAN_JSON' })

        const client = routerModelClient({ stepTimeoutMs: 120_000 })
        const out = await client.complete({ system: 'SYS', user: 'USER' })

        expect(out).toBe('PLAN_JSON')
        expect(callModel).toHaveBeenCalledWith({
            model: FAKE_MODEL,
            system: 'SYS',
            prompt: 'USER',
            taskType: 'planning',
            stepTimeoutMs: 120_000,
        })
    })

    it('passes workspaceId + loaded settings into routeAndCall; defaults taskType', async () => {
        const settings: WorkspaceAISettings = {
            primaryProvider: 'openai',
            fallbackChain: ['anthropic'],
            providers: { openai: { provider: 'openai' }, anthropic: { provider: 'anthropic' } },
        }
        routeAndCall.mockResolvedValue('ok')

        const client = routerModelClient({ workspaceId: 'ws-1', loadSettings: async () => settings })
        await client.complete({ system: 's', user: 'u' })

        expect(routeAndCall).toHaveBeenCalledWith(
            expect.objectContaining({ workspaceId: 'ws-1', taskType: 'planning', settings }),
        )
    })

    it('falls back to anthropic env-key defaultSettings when loader returns null', async () => {
        routeAndCall.mockResolvedValue('ok')

        const client = routerModelClient({ workspaceId: 'ws-new', loadSettings: async () => null })
        await client.complete({ system: 's', user: 'u' })

        expect(routeAndCall).toHaveBeenCalledWith(
            expect.objectContaining({
                settings: { primaryProvider: 'anthropic', fallbackChain: [], providers: { anthropic: { provider: 'anthropic' } } },
            }),
        )
    })

    it('falls back to the env-resolved provider floor when routeAndCall throws (runtime cascade-exhausted)', async () => {
        // Provider-agnostic floor: on exhaustion, resolve a model from SYSTEM env
        // keys and call it — never a hardwired Anthropic (feedback_no_hardwired_llm_provider).
        routeAndCall.mockRejectedValue(new Error('RouterV2CascadeExhausted'))
        resolveModelFromEnv.mockReturnValue(ENV_MODEL)
        callModel.mockResolvedValue({ text: 'ENV_FLOOR' })

        const client = routerModelClient()
        const out = await client.complete({ system: 's', user: 'u' })

        expect(out).toBe('ENV_FLOOR')
        expect(resolveModelFromEnv).toHaveBeenCalledTimes(1)
        expect(callModel).toHaveBeenCalledWith({
            model: ENV_MODEL,
            system: 's',
            prompt: 'u',
            taskType: 'planning',
        })
    })

    it('an empty completion throws in doCall (cascade) → env-resolved floor on exhaustion', async () => {
        // routeAndCall runs doCall; an empty text must throw so routeAndCall cascades.
        // Here we let that throw bubble to model exhaustion, proving '' is never returned.
        routeAndCall.mockImplementation(async (input: { doCall: (m: unknown) => Promise<string> }) =>
            input.doCall(FAKE_MODEL),
        )
        // 1st call = the doCall cascade attempt (empty → throws); 2nd = the floor.
        callModel.mockResolvedValueOnce({ text: '   ' })
        callModel.mockResolvedValueOnce({ text: 'ENV_FLOOR' })
        resolveModelFromEnv.mockReturnValue(ENV_MODEL)

        const client = routerModelClient()
        const out = await client.complete({ system: 's', user: 'u' })

        expect(out).toBe('ENV_FLOOR')
        expect(out).not.toBe('   ')
    })

    it('judging: workspace-pinned judge model is tried first and short-circuits the cascade', async () => {
        buildModel.mockReturnValue(PINNED_MODEL)
        callModel.mockResolvedValue({ text: 'JUDGE' })
        const settings = pinnedSettings()

        const client = routerModelClient({ taskType: 'judging', settings, stepTimeoutMs: 60_000 })
        const out = await client.complete({ system: 'SYS', user: 'USER' })

        expect(out).toBe('JUDGE')
        // 5th arg = modelIdOverride: top precedence in buildModel, so a
        // workspace summarization modelOverride cannot hijack the pinned judge.
        expect(buildModel).toHaveBeenCalledWith(
            'openai',
            { provider: 'openai', apiKey: 'sk-1', baseUrl: 'https://oai.example', model: 'gpt-4o-mini' },
            'summarization',
            settings,
            'gpt-4o-mini',
        )
        expect(callModel).toHaveBeenCalledWith({
            model: PINNED_MODEL,
            system: 'SYS',
            prompt: 'USER',
            taskType: 'judging',
            provider: 'openai',
            stepTimeoutMs: 60_000,
        })
        expect(routeAndCall).not.toHaveBeenCalled()
        expect(resolveModelFromEnv).not.toHaveBeenCalled()
    })

    it('judging: pin at a disconnected provider is skipped straight to the cascade', async () => {
        const settings = pinnedSettings()
        settings.judgeModel = { provider: 'groq', model: 'llama-3.3-70b-versatile' }
        routeAndCall.mockResolvedValue('CASCADE')

        const client = routerModelClient({ taskType: 'judging', settings })
        const out = await client.complete({ system: 's', user: 'u' })

        expect(out).toBe('CASCADE')
        expect(buildModel).not.toHaveBeenCalled()
        expect(routeAndCall).toHaveBeenCalledTimes(1)
    })

    it('judging: pin-skippable error (rate limit) falls through to the cascade', async () => {
        buildModel.mockReturnValue(PINNED_MODEL)
        callModel.mockRejectedValueOnce(new Error('429 rate limit exceeded'))
        routeAndCall.mockResolvedValue('CASCADE')

        const client = routerModelClient({ taskType: 'judging', settings: pinnedSettings() })
        const out = await client.complete({ system: 's', user: 'u' })

        expect(out).toBe('CASCADE')
        expect(routeAndCall).toHaveBeenCalledTimes(1)
        expect(resolveModelFromEnv).not.toHaveBeenCalled()
    })

    it('judging: non-skippable pin error bypasses the cascade to the env-resolved floor', async () => {
        buildModel.mockReturnValue(PINNED_MODEL)
        // 1st call = the pinned judge attempt (throws, non-skippable); 2nd = the floor.
        callModel.mockRejectedValueOnce(new Error('kaboom'))
        callModel.mockResolvedValueOnce({ text: 'ENV_FLOOR' })
        resolveModelFromEnv.mockReturnValue(ENV_MODEL)

        const client = routerModelClient({ taskType: 'judging', settings: pinnedSettings() })
        const out = await client.complete({ system: 's', user: 'u' })

        expect(out).toBe('ENV_FLOOR')
        expect(routeAndCall).not.toHaveBeenCalled()
        expect(callModel).toHaveBeenLastCalledWith({
            model: ENV_MODEL,
            system: 's',
            prompt: 'u',
            taskType: 'judging',
        })
    })

    it('judging: empty pin completion falls through to the cascade', async () => {
        buildModel.mockReturnValue(PINNED_MODEL)
        callModel.mockResolvedValue({ text: '   ' })
        routeAndCall.mockResolvedValue('CASCADE')

        const client = routerModelClient({ taskType: 'judging', settings: pinnedSettings() })
        const out = await client.complete({ system: 's', user: 'u' })

        expect(out).toBe('CASCADE')
        expect(routeAndCall).toHaveBeenCalledTimes(1)
    })

    it('planning: pin is never consulted — routes straight through routeAndCall', async () => {
        const settings = pinnedSettings()
        routeAndCall.mockResolvedValue('PLAN')

        const client = routerModelClient({ taskType: 'planning', settings })
        const out = await client.complete({ system: 's', user: 'u' })

        expect(out).toBe('PLAN')
        expect(buildModel).not.toHaveBeenCalled()
        expect(routeAndCall).toHaveBeenCalledWith(
            expect.objectContaining({ taskType: 'planning', settings }),
        )
    })
})
