// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WorkspaceAISettings } from '../providers/registry.js'

const routeAndCall = vi.fn()
const callModel = vi.fn()
const anthropicComplete = vi.fn()

vi.mock('../providers/router-v2/index.js', () => ({
    routeAndCall: (input: unknown) => routeAndCall(input),
}))
vi.mock('../providers/call-model.js', () => ({
    callModel: (opts: unknown) => callModel(opts),
}))
vi.mock('./anthropic-model-client.js', () => ({
    anthropicModelClient: () => ({ complete: (i: unknown) => anthropicComplete(i) }),
}))

// Import AFTER the mocks are registered.
const { routerModelClient } = await import('./router-model-client.js')

const FAKE_MODEL = { id: 'fake' } as never

beforeEach(() => {
    routeAndCall.mockReset()
    callModel.mockReset()
    anthropicComplete.mockReset()
})

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

    it('falls back to the anthropic floor when routeAndCall throws (runtime cascade-exhausted)', async () => {
        routeAndCall.mockRejectedValue(new Error('RouterV2CascadeExhausted'))
        anthropicComplete.mockResolvedValue('ANTHROPIC_FLOOR')

        const client = routerModelClient()
        const out = await client.complete({ system: 's', user: 'u' })

        expect(out).toBe('ANTHROPIC_FLOOR')
        expect(anthropicComplete).toHaveBeenCalledWith({ system: 's', user: 'u' })
    })

    it('an empty completion throws in doCall (cascade) → floor to anthropic on exhaustion', async () => {
        // routeAndCall runs doCall; an empty text must throw so routeAndCall cascades.
        // Here we let that throw bubble to model exhaustion, proving '' is never returned.
        routeAndCall.mockImplementation(async (input: { doCall: (m: unknown) => Promise<string> }) =>
            input.doCall(FAKE_MODEL),
        )
        callModel.mockResolvedValue({ text: '   ' })
        anthropicComplete.mockResolvedValue('ANTHROPIC_FLOOR')

        const client = routerModelClient()
        const out = await client.complete({ system: 's', user: 'u' })

        expect(out).toBe('ANTHROPIC_FLOOR')
        expect(out).not.toBe('   ')
    })
})
