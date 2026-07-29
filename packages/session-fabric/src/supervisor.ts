// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric supervisor (Phase 2 slice 2d) — pure budget check + orchestration.
 *
 * Framework-free: all time/persistence arrive via `Deps`. The supervisor reads
 * the usage rollup for a session and, if it is over budget, halts a runaway by
 * reclaiming its lease. No IO of its own beyond the injected ports.
 */

import { type Deps, getSession, releaseLease, replayEvents } from './use-cases'
import { summarizeUsage, type UsageSummary } from './usage'

export interface SessionBudget {
    maxCostUsd?: number
    maxTokens?: number
}

export function overBudget(usage: UsageSummary, budget: SessionBudget): { over: boolean; reason?: string } {
    if (budget.maxCostUsd !== undefined && usage.costUsd > budget.maxCostUsd) {
        return { over: true, reason: `costUsd ${usage.costUsd} > maxCostUsd ${budget.maxCostUsd}` }
    }
    const tokens = usage.tokensIn + usage.tokensOut
    if (budget.maxTokens !== undefined && tokens > budget.maxTokens) {
        return { over: true, reason: `tokens ${tokens} > maxTokens ${budget.maxTokens}` }
    }
    return { over: false }
}

export type SuperviseResult = { action: 'none' | 'ok' | 'halted'; reason?: string; usage?: UsageSummary }

// ponytail: supervisor stops a runaway by reclaiming its lease; emitting a supervision `status` event needs a system-actor append path (appendEvent is lease-gated) — add when that exists.
export async function superviseSession(
    deps: Deps,
    input: { sessionId: string; budget: SessionBudget },
): Promise<SuperviseResult> {
    const s = await getSession(deps, input.sessionId)
    const lease = await deps.repo.getLease(input.sessionId)
    const active = lease !== null && lease.claimedUntil.getTime() > deps.clock.now().getTime()
    if (s === null || lease === null || !active) return { action: 'none' }

    const usage = summarizeUsage(await replayEvents(deps, input.sessionId, 0))
    const verdict = overBudget(usage, input.budget)
    if (verdict.over) {
        await releaseLease(deps, { sessionId: input.sessionId, runnerId: lease.runnerId })
        return { action: 'halted', reason: verdict.reason, usage }
    }
    return { action: 'ok', usage }
}
