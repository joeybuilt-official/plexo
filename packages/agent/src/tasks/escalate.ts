// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Escalation summary generator — Phase 2.
 *
 * Produces the 4-field user-facing failure narrative
 * (`what / why / action / recoverable`) defined in
 * Krishnamurthy's section of PLEXO-PROJECT-SYSTEM.md.
 *
 * This is invoked at every terminal-fail site (max-attempts exhausted,
 * wall-clock exceeded, verification failure, planner failure). The output
 * is written to `tasks.outcome_summary` (rendered text) and persisted
 * structurally on the `task.failed` event for the channel projection
 * layer to consume.
 *
 * Falls back to a deterministic hand-written summary if the LLM call
 * fails — escalation MUST always produce a result; the user must never
 * be left wondering what happened.
 */

import { z } from 'zod'
import pino from 'pino'
import { withFallback } from '../providers/registry.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { EscalationSummarySchema, type EscalationSummary, type FailureReason } from './types.js'

const logger = pino({ name: 'task-escalate' })

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface EscalateInput {
    taskId: string
    /** What the user originally asked. Free-form, e.g. "deploy the changelog hotfix". */
    taskDescription: string
    /** Machine-readable reason. Drives the deterministic fallback. */
    failureReason: FailureReason
    /** Free-form error string (stack, tool error, validation message). */
    errorText: string
    /**
     * Optional: which step number was running when the failure occurred.
     * Helps the LLM say "the deploy step failed" instead of just "the task failed".
     */
    failingStepNumber?: number
    /**
     * Optional: the planner's description of the failing step. The LLM uses
     * this to phrase `what` in user-meaningful terms.
     */
    failingStepDescription?: string
    /**
     * Optional: how many step-level retries were attempted before giving up.
     * Surfaces in `why` when relevant.
     */
    attempts?: number
}

// ── LLM prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
    return `You translate mechanical task failures into clear, user-facing summaries.

Produce four fields:
- what: one sentence describing what the task was trying to do at the failing step. Use plain language. No jargon.
- why: one or two sentences explaining what went wrong, in terms a non-engineer can act on. Avoid stack traces.
- action: one sentence with the SINGLE most useful next step the user can take. Be concrete ("Reconnect your GitHub account in Settings → Connections" — not "Check connectivity").
- recoverable: true if the user can fix the problem and the task can resume from where it stopped, false if they must restart from scratch.

Hard rules:
- Do not blame the user.
- Do not promise auto-recovery the system cannot deliver.
- Do not surface internal error codes unless they are unambiguous and actionable.`
}

function buildUserPrompt(input: EscalateInput): string {
    const lines: string[] = [
        `Task: ${input.taskDescription}`,
        `Failure reason (machine code): ${input.failureReason}`,
    ]
    if (input.failingStepNumber !== undefined) {
        lines.push(`Failing step: #${input.failingStepNumber}${input.failingStepDescription ? ` — ${input.failingStepDescription}` : ''}`)
    }
    if (input.attempts !== undefined && input.attempts > 1) {
        lines.push(`Step retries attempted: ${input.attempts}`)
    }
    lines.push('', 'Error text:', input.errorText.slice(0, 4000))
    return lines.join('\n')
}

// ── Deterministic fallback ─────────────────────────────────────────────────

/**
 * Used when the escalation LLM call itself fails. The whole point of
 * escalation is that the user always learns what happened — so we never
 * leave them with a bare "task failed" if the LLM is down.
 */
export function deterministicEscalation(input: EscalateInput): EscalationSummary {
    const rawWhat = input.failingStepDescription
        ? `The task was working on: ${input.failingStepDescription}.`
        : `The task "${input.taskDescription}" was running.`
    const what = rawWhat.length > 400 ? `${rawWhat.slice(0, 397)}...` : rawWhat

    let why: string
    let action: string
    let recoverable: boolean

    switch (input.failureReason) {
        case 'wall_clock_exceeded':
            why = 'The task ran longer than its wall-clock budget allows and was stopped automatically.'
            action = 'Re-submit the task, or break it into smaller pieces if it is consistently slow.'
            recoverable = false
            break
        case 'confirmation_expired':
            why = 'A required confirmation expired before anyone responded.'
            action = 'Re-run the task and confirm the irreversible step when prompted.'
            recoverable = true
            break
        case 'max_attempts_exceeded':
            why = `The task failed ${input.attempts ?? 'multiple'} times in a row and gave up to avoid loops.`
            action = 'Inspect the error below and address the underlying issue before re-submitting.'
            recoverable = false
            break
        case 'cost_ceiling_exceeded':
            why = 'The task hit its spending ceiling before completing.'
            action = 'Raise the per-task cost ceiling in Settings, or simplify the task, then re-submit.'
            recoverable = false
            break
        case 'verification_failed':
            why = 'The task finished its work but verification rejected the result.'
            action = 'Review the verification error below, fix the root cause, and re-submit.'
            recoverable = false
            break
        case 'tool_error':
            why = 'A tool the task needed returned an error that could not be retried away.'
            action = 'Check that the required service is connected and reachable in Settings → Connections.'
            recoverable = true
            break
        case 'planner_failed':
            why = 'The planner could not produce a safe execution plan for this request.'
            action = 'Re-phrase the task with more specifics, or break it into smaller pieces.'
            recoverable = false
            break
        case 'cancelled':
            why = 'The task was cancelled before it could complete.'
            action = 'Re-submit the task if you still want it run.'
            recoverable = false
            break
        case 'unknown':
        default:
            why = 'The task failed for an unspecified reason. The error text below has the underlying detail.'
            action = 'Review the error and re-submit, or contact support if the problem persists.'
            recoverable = false
            break
    }

    return EscalationSummarySchema.parse({ what, why, action, recoverable })
}

// ── Public entry ───────────────────────────────────────────────────────────

/**
 * Generates a 4-field escalation summary for a terminally failed task.
 *
 * Always returns a valid EscalationSummary — falls back to a deterministic
 * mapping if the LLM call fails. Never throws.
 */
export async function generateEscalationSummary(
    input: EscalateInput,
    aiSettings: WorkspaceAISettings,
): Promise<EscalationSummary> {
    try {
        const result = await withFallback(aiSettings, 'summarization', async (model) => {
            const { callModel } = await import('../providers/call-model.js')
            const { object } = await callModel({
                model,
                system: buildSystemPrompt(),
                prompt: buildUserPrompt(input),
                schema: EscalationSummarySchema as z.ZodType<EscalationSummary>,
                schemaName: 'EscalationSummary',
                schemaDescription: 'Four-field user-facing failure narrative.',
                stepTimeoutMs: 20_000,
                taskType: 'summarization',
            })
            return object
        })
        return result
    } catch (err) {
        logger.warn(
            { err, taskId: input.taskId, failureReason: input.failureReason },
            'Escalation LLM call failed — falling back to deterministic summary',
        )
        return deterministicEscalation(input)
    }
}
