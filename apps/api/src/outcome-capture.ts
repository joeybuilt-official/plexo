// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Outcome capture — writes one row per terminal task to outcome_records.
 *
 * REQUIRES migration 0122_outcome_records before activating.
 * All writes are behind OUTCOME_CAPTURE_ENABLED guard — set to true after
 * migration is applied and schema.ts is updated with the outcomeRecords table.
 *
 * Schema (revised, two-column signal model):
 *   outcome_records(id, routine_id, task_id?, trigger,
 *                   automated_outcome TEXT CHECK(...),
 *                   human_verdict TEXT CHECK('accept'|'reject'),
 *                   summary, ts)
 *
 * Signal flow:
 *   executor terminal → recordOutcome() sets automated_outcome
 *   Telegram reply → inject → recordHumanVerdict() sets human_verdict
 *   The two columns are independent — no overwrite risk.
 */

import { logger } from './logger.js'

// Flip to true after migration 0122 is applied + schema.ts has outcomeRecords.
const OUTCOME_CAPTURE_ENABLED = false

export type AutomatedOutcome =
    | 'complete'
    | 'failed'
    | 'cost_ceiling'
    | 'no_credential'
    | 'cancelled'

export type HumanVerdict = 'accept' | 'reject'

export interface OutcomePayload {
    taskId: string
    routineId?: string
    trigger: string
    automatedOutcome: AutomatedOutcome
    summary?: string
}

/**
 * Write an outcome row when a task reaches a terminal state.
 * Call from agent-loop.ts on complete AND failed paths.
 * Non-fatal: any error is logged and swallowed.
 */
export async function recordOutcome(payload: OutcomePayload): Promise<void> {
    if (!OUTCOME_CAPTURE_ENABLED) {
        logger.debug({ taskId: payload.taskId, automatedOutcome: payload.automatedOutcome }, 'outcome-capture: disabled (migration 0122 not applied)')
        return
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { db, outcomeRecords } = await import('@plexo/db') as any
        await db.insert(outcomeRecords).values({
            taskId: payload.taskId,
            routineId: payload.routineId ?? null,
            trigger: payload.trigger,
            automatedOutcome: payload.automatedOutcome,
            summary: payload.summary?.slice(0, 2000) ?? null,
        })
    } catch (err) {
        logger.warn({ err, taskId: payload.taskId }, 'outcome-capture: write failed — non-fatal')
    }
}

/**
 * Record a human verdict arriving via Telegram reply → inject path.
 * Updates human_verdict on the existing row — does NOT touch automated_outcome.
 */
export async function recordHumanVerdict(
    taskId: string,
    verdict: HumanVerdict,
): Promise<void> {
    if (!OUTCOME_CAPTURE_ENABLED) {
        logger.debug({ taskId, verdict }, 'outcome-capture: disabled (migration 0122 not applied)')
        return
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { db, eq, outcomeRecords } = await import('@plexo/db') as any
        await db.update(outcomeRecords)
            .set({ humanVerdict: verdict })
            .where(eq(outcomeRecords.taskId, taskId))
    } catch (err) {
        logger.warn({ err, taskId, verdict }, 'outcome-capture: verdict write failed — non-fatal')
    }
}

/**
 * Build the outcome payload — pure, testable, no DB access.
 */
export function buildOutcomePayload(opts: {
    taskId: string
    taskSource: string | null | undefined
    context: Record<string, unknown> | null | undefined
    outcomeSummary: string | undefined
    automatedOutcome: AutomatedOutcome
}): OutcomePayload {
    const cronJobId = opts.context?.cronJobId as string | undefined
    return {
        taskId: opts.taskId,
        routineId: cronJobId,
        trigger: opts.taskSource ?? 'unknown',
        automatedOutcome: opts.automatedOutcome,
        summary: opts.outcomeSummary?.slice(0, 2000),
    }
}
