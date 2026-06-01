// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Outcome capture — writes one row per terminal task to outcome_records.
 *
 * REQUIRES migration 0122_outcome_records before this module is wired in.
 * Until the migration is applied, do NOT import this from agent-loop.ts.
 *
 * Schema: outcome_records(id, routine_id, task_id, trigger, ground_truth, summary, ts)
 * Ground-truth flow:
 *   executor → writes row with ground_truth = NULL
 *   Telegram reply handler → UPDATE outcome_records SET ground_truth = ? WHERE task_id = ?
 */

import { logger } from './logger.js'

export type OutcomeGroundTruth =
    | 'test_pass'
    | 'pr_merged'
    | 'pr_reverted'
    | 'human_accept'
    | 'human_reject'

export interface OutcomePayload {
    taskId: string
    routineId?: string
    trigger: string
    summary?: string
    groundTruth?: OutcomeGroundTruth
}

/**
 * Write an outcome row on task terminal state.
 * Call from agent-loop.ts on both 'complete' and 'failed' paths.
 * Non-fatal: any error is logged and swallowed.
 *
 * NOTE: requires migration 0122 to be applied first.
 * Uncomment the db import and enable this once the table exists.
 */
export async function recordOutcome(payload: OutcomePayload): Promise<void> {
    try {
        // ── Stubbed until migration 0122 is applied ───────────────────────
        // Uncomment and add `outcome_records` to @plexo/db exports after migration:
        //
        // const { db } = await import('@plexo/db')
        // const { outcomeRecords } = await import('@plexo/db')
        // await db.insert(outcomeRecords).values({
        //     taskId: payload.taskId,
        //     routineId: payload.routineId ?? null,
        //     trigger: payload.trigger,
        //     summary: payload.summary?.slice(0, 2000) ?? null,
        //     groundTruth: payload.groundTruth ?? null,
        // })
        logger.debug({ taskId: payload.taskId, trigger: payload.trigger }, 'outcome-capture: stub (migration 0122 not yet applied)')
    } catch (err) {
        logger.warn({ err, taskId: payload.taskId }, 'outcome-capture: write failed — non-fatal')
    }
}

/**
 * Record a human signal (accept/reject) arriving via Telegram reply.
 * Called by the inject handler when a reply to a routine-task message is received.
 *
 * NOTE: requires migration 0122.
 */
export async function recordHumanSignal(
    taskId: string,
    signal: 'human_accept' | 'human_reject',
): Promise<void> {
    try {
        // const { db, eq } = await import('@plexo/db')
        // const { outcomeRecords } = await import('@plexo/db')
        // await db.update(outcomeRecords)
        //     .set({ groundTruth: signal })
        //     .where(eq(outcomeRecords.taskId, taskId))
        logger.debug({ taskId, signal }, 'outcome-capture: human signal stub (migration 0122 not yet applied)')
    } catch (err) {
        logger.warn({ err, taskId, signal }, 'outcome-capture: human signal write failed — non-fatal')
    }
}

/**
 * Build the outcome payload from agent-loop context — pure, testable.
 */
export function buildOutcomePayload(opts: {
    taskId: string
    taskSource: string | null | undefined
    context: Record<string, unknown> | null | undefined
    outcomeSummary: string | undefined
    groundTruth?: OutcomeGroundTruth
}): OutcomePayload {
    const cronJobId = opts.context?.cronJobId as string | undefined
    return {
        taskId: opts.taskId,
        routineId: cronJobId,
        trigger: opts.taskSource ?? 'unknown',
        summary: opts.outcomeSummary?.slice(0, 2000),
        groundTruth: opts.groundTruth,
    }
}
