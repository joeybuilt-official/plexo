// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Agent SDK runner backend — Phase 2 slice 2b, SAFE half (ADR 0048 / 0050).
 *
 * SECURITY BOUNDARY:
 *   - `plan()` / `verify()` are PURE LLM calls through an injected `ModelClient`
 *     (no shell, no OS, no filesystem, no network of their own).
 *   - `executeStep()` delegates to an injected `ToolExecutor`. The default
 *     `RefuseToolExecutor` HARD-REFUSES every step — real tool execution is the
 *     RCE surface and stays gated behind D2 container isolation (ADR 0050),
 *     which is NOT applied to NAS in this slice.
 *
 * This module imports NO provider SDK: session-fabric stays zero-external-dep
 * (zod only). The concrete Anthropic Messages wiring is an edge adapter in an
 * outer ring (packages/agent), plugged in structurally as a `ModelClient` at
 * the composition root. Deps point inward only.
 *
 * Effect deliberately NOT used here: session-fabric is a framework-free module
 * (hand-rolled Result in ports.ts, Promise-based RunnerBackend port). Matching
 * that convention per CLAUDE.md §9-locked design; see ADR 0048.
 */

import { z } from 'zod'
import type { RunnerBackend, Step, StepResult, VerifyVerdict } from './runner'

/** Minimal, provider-agnostic completion port. The Anthropic adapter lives in packages/agent. */
export interface ModelClient {
    complete(input: { system: string; user: string }): Promise<string>
}

/** Executes a single planned step against the real world. Gated behind D2 (ADR 0050). */
export interface ToolExecutor {
    execute(step: Step): Promise<StepResult>
}

export const REFUSE_MESSAGE = 'tool execution requires D2 jail (ADR 0050) — not applied'

/** Default executor: refuses every step until the D2 container jail is deployed. */
export class RefuseToolExecutor implements ToolExecutor {
    async execute(step: Step): Promise<StepResult> {
        return { stepId: step.id, ok: false, output: REFUSE_MESSAGE }
    }
}

const planSchema = z.array(
    z.object({
        id: z.string(),
        description: z.string(),
        tool: z.string().optional(),
        cmd: z.string().optional(),
        path: z.string().optional(),
        cwd: z.string().optional(),
    }),
)

const verdictSchema = z.object({
    reward: z.number(),
    note: z.string().optional(),
})

export const PLAN_SYSTEM =
    'You are a planning backend for a policy-gated task runner. ' +
    'Decompose the GOAL into an ordered list of concrete steps. ' +
    'Each step is an object: {id, description, tool?, cmd?, path?, cwd?}. ' +
    'Use short slug ids (s0, s1, …). Do NOT execute anything. ' +
    'Respond with ONLY a JSON array of steps — no prose, no code fences.'

export const VERIFY_SYSTEM =
    'You are a verification backend. Given the planned steps and their results ' +
    '(a JSON object {steps, results}), judge whether the goal was satisfied. ' +
    'Respond with ONLY a JSON object {"reward": <0..1>, "note": <short string>} — ' +
    'reward 1 = fully satisfied, 0 = not at all. No prose, no code fences.'

/** Pull the first JSON array/object out of a model response, tolerating fences/prose. */
function extractJson(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const body = (fenced?.[1] ?? text).trim()
    const start = body.search(/[[{]/)
    if (start === -1) return body
    const close = body.charAt(start) === '[' ? ']' : '}'
    const end = body.lastIndexOf(close)
    return end > start ? body.slice(start, end + 1) : body.slice(start)
}

function parseJson(where: string, raw: string): unknown {
    try {
        return JSON.parse(extractJson(raw))
    } catch (e) {
        throw new Error(`AgentSdkBackend.${where}: invalid JSON in model output: ${(e as Error).message}`)
    }
}

/**
 * LLM-driven `RunnerBackend`. `plan`/`verify` call the model; `executeStep`
 * refuses (default) or delegates to an injected, D2-gated `ToolExecutor`.
 */
export class AgentSdkBackend implements RunnerBackend {
    constructor(
        private readonly model: ModelClient,
        // D2 default preserved: passing `undefined` here still yields RefuseToolExecutor.
        private readonly toolExecutor: ToolExecutor = new RefuseToolExecutor(),
        private readonly verifyModel?: ModelClient,
    ) {}

    async plan(goal: string): Promise<Step[]> {
        const raw = await this.model.complete({ system: PLAN_SYSTEM, user: goal })
        const parsed = planSchema.safeParse(parseJson('plan', raw))
        if (!parsed.success) {
            throw new Error(`AgentSdkBackend.plan: model output did not match plan schema: ${parsed.error.message}`)
        }
        return parsed.data
    }

    async executeStep(step: Step): Promise<StepResult> {
        return this.toolExecutor.execute(step)
    }

    async verify(steps: Step[], results: StepResult[]): Promise<VerifyVerdict> {
        const raw = await (this.verifyModel ?? this.model).complete({ system: VERIFY_SYSTEM, user: JSON.stringify({ steps, results }) })
        const parsed = verdictSchema.safeParse(parseJson('verify', raw))
        if (!parsed.success) {
            throw new Error(`AgentSdkBackend.verify: model output did not match verdict schema: ${parsed.error.message}`)
        }
        const reward = Math.max(0, Math.min(1, parsed.data.reward))
        // ponytail: LLM self-verify has no dedicated outcomeKind; 'test' = "acceptance asserted".
        // Add a 'model' kind to VerifyVerdict if this must be distinguished from a real test signal.
        return { outcomeKind: 'test', reward, rewardSource: 'agent-sdk-verify', note: parsed.data.note }
    }
}
