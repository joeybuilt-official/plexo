// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Project System types — Phase 2.
 *
 * Shared schemas for the durable task execution surface. Lives alongside
 * the existing `planner` and `executor` modules; does not replace them.
 *
 * The canonical `ExecutionPlan` / `PlanStep` / `OneWayDoor` types are
 * defined in ../types.ts and re-exported below for convenience. Anything
 * NEW to the project-system rebuild (4-field escalation summary, machine-
 * readable failure reasons, step lifecycle states) lives here.
 */

import { z } from 'zod'

export type {
    ExecutionPlan,
    PlanStep,
    OneWayDoor,
    PlannerResult,
    ClarificationRequest,
    ClarificationAlternative,
} from '../types.js'

// ── Failure reasons (machine-readable) ─────────────────────────────────────

/**
 * Enumerated failure reasons written to `tasks.failure_reason`. Distinct from
 * `outcome_summary`, which carries the user-facing narrative.
 *
 * Add new variants here, not as ad-hoc strings at call sites — the UI and
 * memory extractor switch on this set.
 */
export const FailureReason = {
    WallClockExceeded: 'wall_clock_exceeded',
    ConfirmationExpired: 'confirmation_expired',
    MaxAttemptsExceeded: 'max_attempts_exceeded',
    ToolError: 'tool_error',
    VerificationFailed: 'verification_failed',
    PlannerFailed: 'planner_failed',
    CostCeilingExceeded: 'cost_ceiling_exceeded',
    Cancelled: 'cancelled',
    Unknown: 'unknown',
} as const

export type FailureReason = typeof FailureReason[keyof typeof FailureReason]

export const FailureReasonSchema = z.enum([
    FailureReason.WallClockExceeded,
    FailureReason.ConfirmationExpired,
    FailureReason.MaxAttemptsExceeded,
    FailureReason.ToolError,
    FailureReason.VerificationFailed,
    FailureReason.PlannerFailed,
    FailureReason.CostCeilingExceeded,
    FailureReason.Cancelled,
    FailureReason.Unknown,
])

// ── Escalation summary (4-field) ───────────────────────────────────────────

/**
 * Krishnamurthy's 4-field escalation contract. The escalation LLM call
 * translates a mechanical failure into something the user can act on.
 *
 * - `what`: what the task was trying to do at the failing step.
 * - `why`: what specifically went wrong, in plain language.
 * - `action`: the concrete next action available to the user.
 * - `recoverable`: true if the user can resume from where it failed,
 *                  false if they must restart.
 */
export const EscalationSummarySchema = z.object({
    what: z.string().min(1).max(400),
    why: z.string().min(1).max(800),
    action: z.string().min(1).max(400),
    recoverable: z.boolean(),
})

export type EscalationSummary = z.infer<typeof EscalationSummarySchema>

// ── Task step lifecycle (DB-aligned) ───────────────────────────────────────

/**
 * Mirrors the `task_step_state` enum in the DB schema. Source of truth
 * is packages/db (taskStepStateEnum); this re-declaration is a string-
 * literal union for type-checking call sites without a runtime DB import.
 */
export type TaskStepState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/**
 * Mirrors the `task_step_type` enum. Drives executor dispatch:
 * - `tool_call`: invoke a registered tool with `step_spec.toolName` + args.
 * - `confirmation`: pause the task and request user approval.
 * - `verification`: run a verification strategy (deterministic or LLM judge).
 * - `llm_generation`: free-form generation step (rare — most work goes through tools).
 */
export type TaskStepType = 'tool_call' | 'confirmation' | 'verification' | 'llm_generation'

// ── Events emitted on terminal state ───────────────────────────────────────

/**
 * Payload shape for the `task.failed` event. Co-existing with the existing
 * `task.completed` topic on `packages/agent/src/plugins/event-bus.ts`. The
 * memory `reflectOnTask` listener (Phase 6) consumes both.
 */
export const TaskFailedPayloadSchema = z.object({
    taskId: z.string(),
    workspaceId: z.string(),
    failureReason: FailureReasonSchema,
    summary: EscalationSummarySchema.nullable(),
    /**
     * Phase 7.2 — A2A child task attribution. Present iff this task was
     * spawned from another task (tasks.parent_id NOT NULL). Lets a parent
     * workflow filter TASK_FAILED events to "events from my children".
     */
    parentTaskId: z.string().nullable().optional(),
})

export type TaskFailedPayload = z.infer<typeof TaskFailedPayloadSchema>

/**
 * Payload shape for the `task.completed` event. The reflectOnTask listener
 * formats this into a synthetic turn and routes it through the memory
 * extraction pipeline. The existing memory consolidation listener also
 * subscribes to this topic for anti-bloat.
 */
export const TaskCompletedPayloadSchema = z.object({
    taskId: z.string(),
    workspaceId: z.string(),
    description: z.string(),
    outcome: z.enum(['success', 'partial']),
    outcomeSummary: z.string().optional(),
    qualityScore: z.number().optional(),
    durationMs: z.number().optional(),
    toolsUsed: z.array(z.string()).optional(),
    /**
     * Phase 7.2 — A2A child task attribution. Present iff this task was
     * spawned from another task (tasks.parent_id NOT NULL). Lets a parent
     * workflow filter TASK_COMPLETED events to "events from my children".
     */
    parentTaskId: z.string().nullable().optional(),
})

export type TaskCompletedPayload = z.infer<typeof TaskCompletedPayloadSchema>
