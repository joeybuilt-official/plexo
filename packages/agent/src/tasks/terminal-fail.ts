// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Terminal-fail helper — Phase 2.
 *
 * One-stop call for "this task is permanently dead":
 *   1. Generate the 4-field user-facing escalation summary (LLM with
 *      deterministic fallback). Never throws.
 *   2. Write `status='failed'`, `failed_at`, `failure_reason`, and a
 *      formatted `outcome_summary` to the task row in one update.
 *   3. Publish `TOPICS.TASK_FAILED` with a `TaskFailedPayload`.
 *
 * Replaces ad-hoc `failTask(taskId, reason)` calls that lost the structured
 * failure metadata before the Phase 1 schema additions made it durable.
 */

import pino from 'pino'
import { eq, and } from 'drizzle-orm'
import { db, tasks, type TaskStatus } from '@plexo/db'
import { eventBus, TOPICS } from '../plugins/event-bus.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { generateEscalationSummary, deterministicEscalation, type EscalateInput } from './escalate.js'
import type { EscalationSummary, FailureReason, TaskFailedPayload } from './types.js'

const logger = pino({ name: 'task-terminal-fail' })

export interface MarkTaskFailedInput {
    taskId: string
    workspaceId: string
    failureReason: FailureReason
    /** Free-form error or reason text (stack, validation message, "no AI credential", etc.). */
    errorText: string
    /** What the user originally asked. Used by the escalation LLM. */
    taskDescription: string
    /** Optional: failing step number from the plan. */
    failingStepNumber?: number
    /** Optional: failing step description from the plan. */
    failingStepDescription?: string
    /** Optional: number of retry attempts before giving up. */
    attempts?: number
    /**
     * Optional workspace AI settings. When provided, escalation uses the
     * configured LLM chain. When absent (e.g. no_ai_credential path), the
     * deterministic mapping is used and no LLM call is made.
     */
    aiSettings?: WorkspaceAISettings
    /**
     * Optional guard: only transition if the task is currently in this
     * status. Used by paths that race with user cancellation (e.g. the
     * approval timeout path: only fail if still 'awaiting_approval').
     */
    requireFromStatus?: TaskStatus
}

export interface MarkTaskFailedResult {
    /** True when the DB row was actually updated (or the guard matched on a no-op). */
    transitioned: boolean
    summary: EscalationSummary
}

function renderOutcome(summary: EscalationSummary): string {
    return `${summary.what}\n\n${summary.why}\n\nNext: ${summary.action}`
}

/**
 * Transition a task to `failed` with full structured metadata.
 *
 * Idempotent on `status='failed'` — calling twice on the same task overwrites
 * `outcome_summary` but does not double-emit events (callers check the prior
 * status before invoking).
 */
export async function markTaskFailed(input: MarkTaskFailedInput): Promise<MarkTaskFailedResult> {
    const escalateInput: EscalateInput = {
        taskId: input.taskId,
        taskDescription: input.taskDescription,
        failureReason: input.failureReason,
        errorText: input.errorText,
        failingStepNumber: input.failingStepNumber,
        failingStepDescription: input.failingStepDescription,
        attempts: input.attempts,
    }

    const summary: EscalationSummary = input.aiSettings
        ? await generateEscalationSummary(escalateInput, input.aiSettings)
        : deterministicEscalation(escalateInput)

    const whereClause = input.requireFromStatus
        ? and(eq(tasks.id, input.taskId), eq(tasks.status, input.requireFromStatus))
        : eq(tasks.id, input.taskId)

    let transitioned = false
    let parentTaskId: string | null = null
    try {
        const updated = await db.update(tasks)
            .set({
                status: 'failed',
                failedAt: new Date(),
                failureReason: input.failureReason,
                outcomeSummary: renderOutcome(summary),
                claimedAt: null,
                claimedUntil: null,
            })
            .where(whereClause)
            .returning({ id: tasks.id, parentId: tasks.parentId })
        transitioned = updated.length > 0
        parentTaskId = updated[0]?.parentId ?? null
    } catch (err) {
        logger.error(
            { err, taskId: input.taskId, failureReason: input.failureReason },
            'markTaskFailed: DB update failed — task may be in inconsistent state',
        )
        throw err
    }

    if (!transitioned) {
        // Guarded update did not match — task was already in a different status
        // (likely cancelled during a wait). Skip the event so subscribers don't
        // see a phantom failure.
        return { transitioned: false, summary }
    }

    const payload: TaskFailedPayload = {
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        failureReason: input.failureReason,
        summary,
        parentTaskId,
    }
    try {
        eventBus.publish(TOPICS.TASK_FAILED, payload)
    } catch (err) {
        logger.warn({ err, taskId: input.taskId }, 'TASK_FAILED publish failed — non-fatal')
    }

    return { transitioned: true, summary }
}
