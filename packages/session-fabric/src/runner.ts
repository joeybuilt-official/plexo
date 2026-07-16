// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric — plan/verify runner (pure orchestration).
 *
 * SAFETY-CRITICAL: this module ONLY sequences steps, policy-gates each one, and
 * emits session events. It NEVER executes real shell/tools — `RunnerBackend` is
 * an injected PORT; only test doubles or an out-of-process adapter implement it.
 * Framework-free: all time/ids/persistence arrive via `Deps`; no IO of its own.
 */

import { evaluatePolicy, type PolicyAction, type PolicyRule } from './policy'
import { type Deps, appendEvent, claimLease, releaseLease } from './use-cases'
import { type Result, err, ok } from './ports'
import type { Tier } from './tiers'

/** Lease TTL for a plan/verify run; renewed elsewhere if a run outlives it. */
const RUN_LEASE_TTL_MS = 60_000

export interface Step {
    id: string
    description: string
    tool?: string
    cmd?: string
    path?: string
    cwd?: string
}

export interface StepResult {
    stepId: string
    ok: boolean
    output?: string
}

export interface VerifyVerdict {
    outcomeKind: 'gate' | 'test' | 'ci' | 'human'
    reward: number
    rewardSource: string
    note?: string
}

export interface RunnerBackend {
    plan(goal: string): Promise<Step[]>
    executeStep(step: Step): Promise<StepResult>
    verify(steps: Step[], results: StepResult[]): Promise<VerifyVerdict>
}

export type RunOutcome = {
    status: 'completed' | 'denied' | 'paused' | 'no_lease'
    executedStepIds: string[]
    pausedOnStepId?: string
    deniedStepId?: string
    verdict?: VerifyVerdict
}

export async function runPlanVerify(
    deps: Deps,
    backend: RunnerBackend,
    input: { sessionId: string; runnerId: string; goal: string; tier: Tier; rules: readonly PolicyRule[] },
): Promise<Result<RunOutcome>> {
    const { sessionId, runnerId } = input

    // No lease → emit NOTHING; the caller is not the single writer.
    const claimed = await claimLease(deps, { sessionId, runnerId, ttlMs: RUN_LEASE_TTL_MS })
    if (!claimed.ok) return err('NO_LEASE', `runner ${runnerId} could not lease session ${sessionId}`)

    const steps = await backend.plan(input.goal)
    const planned = await appendEvent(deps, {
        sessionId, runnerId, kind: 'plan', actorType: 'runner', actorId: runnerId, payload: { steps },
    })
    if (!planned.ok) return planned

    const executedStepIds: string[] = []
    const results: StepResult[] = []
    let status: RunOutcome['status'] = 'completed'
    let pausedOnStepId: string | undefined
    let deniedStepId: string | undefined

    for (const step of steps) {
        const action: PolicyAction = { tool: step.tool, cmd: step.cmd, path: step.path, cwd: step.cwd }
        const ev = evaluatePolicy(action, input.tier, input.rules)

        if (ev.decision === 'deny') {
            const e = await appendEvent(deps, {
                sessionId, runnerId, kind: 'status', actorType: 'runner', actorId: runnerId,
                payload: { denied: true, stepId: step.id, ruleId: ev.ruleId, teach: ev.teach },
            })
            if (!e.ok) return e
            deniedStepId = step.id
            status = 'denied'
            break
        }

        if (ev.decision === 'gate') {
            const e = await appendEvent(deps, {
                sessionId, runnerId, kind: 'approval_request', actorType: 'runner', actorId: runnerId,
                payload: { stepId: step.id, ruleId: ev.ruleId, teach: ev.teach, action },
            })
            if (!e.ok) return e
            pausedOnStepId = step.id
            status = 'paused'
            break
        }

        const call = await appendEvent(deps, {
            sessionId, runnerId, kind: 'tool_call', actorType: 'runner', actorId: runnerId,
            payload: { stepId: step.id, action },
        })
        if (!call.ok) return call

        const r = await backend.executeStep(step)
        results.push(r)

        const resEv = await appendEvent(deps, {
            sessionId, runnerId, kind: 'tool_result', actorType: 'runner', actorId: runnerId,
            payload: { stepId: step.id, ok: r.ok, output: r.output },
        })
        if (!resEv.ok) return resEv

        executedStepIds.push(step.id)
    }

    let verdict: VerifyVerdict | undefined
    if (status === 'completed') {
        verdict = await backend.verify(steps, results)
        const outcome = await appendEvent(deps, {
            sessionId, runnerId, kind: 'outcome', actorType: 'runner', actorId: runnerId,
            outcomeKind: verdict.outcomeKind, reward: verdict.reward, reward_source: verdict.rewardSource,
            payload: { note: verdict.note },
        })
        if (!outcome.ok) return outcome
    }

    // Lease policy (explicit, not a blanket finally):
    //  - paused: KEEP the lease — approval is pending; releasing would let a
    //    second runner steal the in-flight session before the human decides.
    //  - denied / completed: RELEASE — this runner is done with the session.
    if (status === 'denied' || status === 'completed') {
        await releaseLease(deps, { sessionId, runnerId })
    }

    return ok({ status, executedStepIds, pausedOnStepId, deniedStepId, verdict })
}
