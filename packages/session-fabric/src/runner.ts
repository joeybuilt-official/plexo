// SPDX-License-Identifier: MIT
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
import { type Deps, appendEvent, claimLease, releaseLease, replayEvents } from './use-cases'
import { type Result, err, ok } from './ports'
import type { Tier } from './tiers'

/**
 * Lease TTL for a plan/verify run. The run also RE-CLAIMS the lease around each
 * slow model call (plan/verify) — the holder re-wins unless another runner stole
 * an expired lease — so real model latency can't silently expire it mid-run.
 */
const RUN_LEASE_TTL_MS = 120_000

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

/** Per-run context shared by the initial drive and any approval-resume. */
export interface DriveContext {
    sessionId: string
    runnerId: string
    tier: Tier
    rules: readonly PolicyRule[]
}

export interface ResumeRunInput {
    sessionId: string
    runnerId: string
    tier: Tier
    rules: readonly PolicyRule[]
    stepId: string
    decision: 'approve' | 'deny'
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

    // plan() is a model call; a throw here would escape with the lease still
    // held, leaving the session unusable until the TTL expired. Release first,
    // then rethrow — the caller still sees the failure, but the session is free.
    let steps: Step[]
    try {
        steps = await backend.plan(input.goal)
    } catch (e) {
        await releaseLease(deps, { sessionId, runnerId })
        throw e
    }
    // plan() can also outlast the TTL; refresh the lease before persisting.
    // Fails only if another runner stole the (expired) lease.
    const refreshed = await claimLease(deps, { sessionId, runnerId, ttlMs: RUN_LEASE_TTL_MS })
    if (!refreshed.ok) return err('NO_LEASE', `runner ${runnerId} lost session ${sessionId} lease during planning`)

    const planned = await appendEvent(deps, {
        sessionId, runnerId, kind: 'plan', actorType: 'runner', actorId: runnerId, payload: { steps },
    })
    if (!planned.ok) return planned

    return driveFrom(deps, backend, { sessionId, runnerId, tier: input.tier, rules: input.rules }, steps, 0, [])
}

/**
 * How many times a single step is dispatched to the backend before its failure
 * becomes a step result. One initial attempt plus one re-dispatch.
 */
const STEP_DISPATCH_ATTEMPTS = 2

/**
 * Dispatch one step, re-dispatching exactly once if the backend *throws*.
 *
 * A throw out of `executeStep` is a transport-level failure, not a verdict on
 * the step. Before this guard it escaped `driveFrom` entirely: no `tool_result`
 * was ever appended and no lease was ever released, so the session sat leased
 * until its TTL expired and the run vanished with no record of why — one flaky
 * dispatch killed the session.
 *
 * Idempotent per step, per ADR 0051: the caller appends exactly one `tool_call`
 * before this and exactly one `tool_result` after it no matter which attempt
 * produced the result, so the event log keeps its gap-free
 * plan/tool_call/tool_result shape and a replay reconstructs the same run.
 *
 * A second failure is converted into a failed `StepResult` rather than rethrown,
 * so the run finishes down its normal path — `tool_result` → `verify` → `outcome`
 * → lease released — and `verify` sees the failure and scores it.
 */
async function dispatchStep(
    backend: RunnerBackend,
    step: Step,
): Promise<{ result: StepResult; attempts: number; error?: string }> {
    let lastError = ''
    for (let attempt = 1; attempt <= STEP_DISPATCH_ATTEMPTS; attempt += 1) {
        try {
            return { result: await backend.executeStep(step), attempts: attempt }
        } catch (e) {
            lastError = e instanceof Error ? e.message : String(e)
        }
    }
    return {
        result: {
            stepId: step.id,
            ok: false,
            output: `ERROR: step dispatch threw on all ${STEP_DISPATCH_ATTEMPTS} attempts: ${lastError}`,
        },
        attempts: STEP_DISPATCH_ATTEMPTS,
        error: lastError,
    }
}

/**
 * Re-enterable step loop. Executes `steps` from `startIndex`, policy-gating each
 * one, appending session events, and carrying `priorResults` into verify. When
 * `approvedStepId` matches the current step, its policy gate is SKIPPED (a human
 * already approved it) and it is executed; every other step is gated normally.
 *
 * Lease policy is explicit: RELEASE on denied/completed, HOLD on paused (an
 * approval is pending — releasing would let a second runner steal the session).
 */
export async function driveFrom(
    deps: Deps,
    backend: RunnerBackend,
    ctx: DriveContext,
    steps: Step[],
    startIndex: number,
    priorResults: StepResult[],
    approvedStepId?: string,
): Promise<Result<RunOutcome>> {
    const { sessionId, runnerId } = ctx

    const executedStepIds: string[] = []
    const results: StepResult[] = [...priorResults]
    let status: RunOutcome['status'] = 'completed'
    let pausedOnStepId: string | undefined
    let deniedStepId: string | undefined

    for (let i = startIndex; i < steps.length; i += 1) {
        const step = steps[i]!
        const action: PolicyAction = { tool: step.tool, cmd: step.cmd, path: step.path, cwd: step.cwd }

        if (approvedStepId === undefined || step.id !== approvedStepId) {
            const ev = evaluatePolicy(action, ctx.tier, ctx.rules)

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
        }

        const call = await appendEvent(deps, {
            sessionId, runnerId, kind: 'tool_call', actorType: 'runner', actorId: runnerId,
            payload: { stepId: step.id, action },
        })
        if (!call.ok) return call

        const dispatched = await dispatchStep(backend, step)
        const r = dispatched.result
        results.push(r)

        // `attempts`/`error` are omitted on the (overwhelmingly common) first-try
        // path, so a healthy run's payload is byte-identical to before B15.
        const resEv = await appendEvent(deps, {
            sessionId, runnerId, kind: 'tool_result', actorType: 'runner', actorId: runnerId,
            payload: {
                stepId: step.id,
                ok: r.ok,
                output: r.output,
                ...(dispatched.attempts > 1 && { attempts: dispatched.attempts }),
                ...(dispatched.error !== undefined && { error: dispatched.error }),
            },
        })
        if (!resEv.ok) return resEv

        executedStepIds.push(step.id)
    }

    let verdict: VerifyVerdict | undefined
    if (status === 'completed') {
        // Same lease-safety guard as plan(): an escaping verify() throw would
        // strand the lease with every step already executed and recorded.
        try {
            verdict = await backend.verify(steps, results)
        } catch (e) {
            await releaseLease(deps, { sessionId, runnerId })
            throw e
        }
        // verify() is a model call too; refresh the lease before the outcome append.
        const reclaimed = await claimLease(deps, { sessionId, runnerId, ttlMs: RUN_LEASE_TTL_MS })
        if (!reclaimed.ok) return err('NO_LEASE', `runner ${runnerId} lost session ${sessionId} lease during verify`)

        const outcome = await appendEvent(deps, {
            sessionId, runnerId, kind: 'outcome', actorType: 'runner', actorId: runnerId,
            outcomeKind: verdict.outcomeKind, reward: verdict.reward, reward_source: verdict.rewardSource,
            payload: { note: verdict.note },
        })
        if (!outcome.ok) return outcome
    }

    if (status === 'denied' || status === 'completed') {
        await releaseLease(deps, { sessionId, runnerId })
    }

    return ok({ status, executedStepIds, pausedOnStepId, deniedStepId, verdict })
}

interface PlanPayload {
    steps: Step[]
}
interface StepIdPayload {
    stepId: string
}
interface DecisionPayload {
    stepId: string
    decision: 'approve' | 'deny'
}
interface ToolResultPayload {
    stepId: string
    ok: boolean
    output?: string
}
interface OutcomeNotePayload {
    note?: string
}

/**
 * Resolve a paused run's pending approval. Reconstructs the plan + prior step
 * results from the event log, records the human's `approval_decision`, then
 * either denies (status→denied, lease released) or resumes execution from the
 * paused step (its gate pre-approved). Idempotent per `stepId`: a repeated
 * decision is a no-op that returns the already-resolved outcome.
 */
export async function resumeRun(
    deps: Deps,
    backend: RunnerBackend,
    input: ResumeRunInput,
): Promise<Result<RunOutcome>> {
    const { sessionId, runnerId, stepId, decision } = input

    const events = await replayEvents(deps, sessionId, 0)

    const planEvents = events.filter((e) => e.kind === 'plan')
    if (planEvents.length === 0) return err('SESSION_NOT_FOUND', `session ${sessionId} has no plan event to resume`)
    if (planEvents.length > 1) return err('SEQ_CONFLICT', `session ${sessionId} has multiple plan events; log is ambiguous`)

    const steps = (planEvents[0]!.payload as PlanPayload).steps
    if (!steps.some((s) => s.id === stepId)) return err('SESSION_NOT_FOUND', `step ${stepId} is not in the plan for session ${sessionId}`)

    const priorResults: StepResult[] = events
        .filter((e) => e.kind === 'tool_result')
        .map((e) => {
            const p = e.payload as ToolResultPayload
            return { stepId: p.stepId, ok: p.ok, output: p.output }
        })

    // Idempotency: a decision already recorded for this step is a no-op. Checked
    // before re-claiming the lease so a duplicate never acquires a dangling lease.
    const priorDecision = events.find(
        (e) => e.kind === 'approval_decision' && (e.payload as DecisionPayload).stepId === stepId,
    )
    if (priorDecision) {
        const executedStepIds = priorResults.map((r) => r.stepId)
        if ((priorDecision.payload as DecisionPayload).decision === 'deny') {
            return ok({ status: 'denied', executedStepIds, deniedStepId: stepId })
        }
        const outcomeEv = events.find((e) => e.kind === 'outcome')
        const verdict: VerifyVerdict | undefined = outcomeEv
            ? {
                  outcomeKind: (outcomeEv.outcomeKind ?? 'gate') as VerifyVerdict['outcomeKind'],
                  reward: outcomeEv.reward ?? 0,
                  rewardSource: outcomeEv.reward_source ?? 'resume',
                  note: (outcomeEv.payload as OutcomeNotePayload).note,
              }
            : undefined
        return ok({ status: outcomeEv ? 'completed' : 'paused', executedStepIds, verdict, pausedOnStepId: outcomeEv ? undefined : stepId })
    }

    const lastRequest = [...events].reverse().find((e) => e.kind === 'approval_request')
    if (!lastRequest) return err('SESSION_NOT_FOUND', `session ${sessionId} has no pending approval to resume`)
    const pausedStepId = (lastRequest.payload as StepIdPayload).stepId
    const pausedIndex = steps.findIndex((s) => s.id === pausedStepId)
    if (pausedIndex === -1) return err('SESSION_NOT_FOUND', `approval_request references unknown step ${pausedStepId}`)

    // The decision must target the step that is actually gated. Approving a
    // different step would record a spurious decision and silently re-pause.
    if (stepId !== pausedStepId) {
        return err('SESSION_NOT_FOUND', `step ${stepId} is not the pending approval (session ${sessionId} is paused on ${pausedStepId})`)
    }

    const claimed = await claimLease(deps, { sessionId, runnerId, ttlMs: RUN_LEASE_TTL_MS })
    if (!claimed.ok) return err('NO_LEASE', `runner ${runnerId} could not lease session ${sessionId} to resume`)

    const decided = await appendEvent(deps, {
        sessionId, runnerId, kind: 'approval_decision', actorType: 'runner', actorId: runnerId,
        payload: { stepId, decision, runnerId },
    })
    if (!decided.ok) return decided

    const ctx: DriveContext = { sessionId, runnerId, tier: input.tier, rules: input.rules }

    if (decision === 'deny') {
        const e = await appendEvent(deps, {
            sessionId, runnerId, kind: 'status', actorType: 'runner', actorId: runnerId,
            payload: { denied: true, stepId },
        })
        if (!e.ok) return e
        await releaseLease(deps, { sessionId, runnerId })
        return ok({ status: 'denied', executedStepIds: priorResults.map((r) => r.stepId), deniedStepId: stepId })
    }

    return driveFrom(deps, backend, ctx, steps, pausedIndex, priorResults, stepId)
}
