// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import {
    AgentSdkBackend,
    RefuseToolExecutor,
    REFUSE_MESSAGE,
    type ModelClient,
    type ToolExecutor,
} from './agent-backend'
import type { Step, StepResult } from './runner'

/** Model client that replays a fixed script of responses, recording prompts. */
function scriptedModel(responses: string[]): ModelClient & { prompts: Array<{ system: string; user: string }> } {
    const prompts: Array<{ system: string; user: string }> = []
    let i = 0
    return {
        prompts,
        async complete(input) {
            prompts.push(input)
            return responses[i++] ?? ''
        },
    }
}

const STEP: Step = { id: 's0', description: 'read a file', tool: 'Read', path: '/a' }

describe('AgentSdkBackend.plan', () => {
    it('parses a JSON array of steps', async () => {
        const model = scriptedModel(['[{"id":"s0","description":"read","tool":"Read","path":"/a"}]'])
        const backend = new AgentSdkBackend(model)
        const steps = await backend.plan('read /a')
        expect(steps).toEqual([{ id: 's0', description: 'read', tool: 'Read', path: '/a' }])
        expect(model.prompts[0]?.user).toBe('read /a')
    })

    it('tolerates code fences and surrounding prose', async () => {
        const model = scriptedModel(['Here you go:\n```json\n[{"id":"s0","description":"noop"}]\n```\n'])
        const steps = await new AgentSdkBackend(model).plan('g')
        expect(steps).toEqual([{ id: 's0', description: 'noop' }])
    })

    it('throws on non-JSON output', async () => {
        const backend = new AgentSdkBackend(scriptedModel(['I refuse to plan.']))
        await expect(backend.plan('g')).rejects.toThrow(/plan: invalid JSON/)
    })

    it('throws when output does not match the step schema', async () => {
        const backend = new AgentSdkBackend(scriptedModel(['[{"id":123}]']))
        await expect(backend.plan('g')).rejects.toThrow(/did not match plan schema/)
    })
})

describe('AgentSdkBackend.executeStep', () => {
    it('refuses by default (RefuseToolExecutor) — no execution surface', async () => {
        const backend = new AgentSdkBackend(scriptedModel([]))
        const r = await backend.executeStep(STEP)
        expect(r).toEqual({ stepId: 's0', ok: false, output: REFUSE_MESSAGE })
    })

    it('delegates to an injected ToolExecutor when one is provided', async () => {
        const seen: string[] = []
        const exec: ToolExecutor = {
            async execute(step): Promise<StepResult> {
                seen.push(step.id)
                return { stepId: step.id, ok: true, output: 'done' }
            },
        }
        const backend = new AgentSdkBackend(scriptedModel([]), exec)
        const r = await backend.executeStep(STEP)
        expect(r.ok).toBe(true)
        expect(seen).toEqual(['s0'])
    })
})

describe('RefuseToolExecutor', () => {
    it('always refuses with the D2-gate message', async () => {
        const r = await new RefuseToolExecutor().execute(STEP)
        expect(r).toEqual({ stepId: 's0', ok: false, output: REFUSE_MESSAGE })
    })
})

describe('AgentSdkBackend.verify', () => {
    it('returns a test verdict with the model reward', async () => {
        const backend = new AgentSdkBackend(scriptedModel(['{"reward":1,"note":"looks good"}']))
        const v = await backend.verify([STEP], [{ stepId: 's0', ok: true }])
        expect(v).toEqual({
            outcomeKind: 'test',
            reward: 1,
            rewardSource: 'agent-sdk-verify@claude-opus-4-8',
            note: 'looks good',
        })
    })

    it('clamps out-of-range rewards to [0,1]', async () => {
        const hi = await new AgentSdkBackend(scriptedModel(['{"reward":5}'])).verify([], [])
        const lo = await new AgentSdkBackend(scriptedModel(['{"reward":-3}'])).verify([], [])
        expect(hi.reward).toBe(1)
        expect(lo.reward).toBe(0)
    })

    it('throws on a malformed verdict', async () => {
        const backend = new AgentSdkBackend(scriptedModel(['{"note":"no reward"}']))
        await expect(backend.verify([], [])).rejects.toThrow(/did not match verdict schema/)
    })
})
