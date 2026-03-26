// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo Fabric Agent Contract Types
 * Corresponds to §8 of the Plexo Fabric Specification v0.4.0
 *
 * An Agent is NOT a subtype of Extension. An Agent is an autonomous actor
 * with a goal, a planning loop, and an identity. It orchestrates any number
 * of Extensions to accomplish work.
 *
 * §23 integration: Agents MUST implement escalate() for human oversight.
 * §22 integration: Agents MAY delegate to external A2A agents.
 * §24 integration: Agent actions are logged with model context in the audit trail.
 */

import type { EscalationRequest, EscalationResult, EscalationTrigger } from './escalation.js'

// ---------------------------------------------------------------------------
// One-Way Door (§8.4)
// ---------------------------------------------------------------------------

export type OneWayDoorType =
    | 'irreversible_action'
    | 'external_write'
    | 'financial_transaction'
    | 'data_deletion'
    | 'permission_escalation'

export interface OneWayDoor {
    type: OneWayDoorType
    description: string
    /** What the agent intends to do */
    action: string
    /** What happens if user approves */
    consequence: string
    /** Whether this can be undone */
    reversible: false
}

// ---------------------------------------------------------------------------
// Escalation Reasons (expanded for §23 triggers)
// ---------------------------------------------------------------------------

export type EscalationReason =
    | 'ambiguous_goal'
    | 'one_way_door'
    | 'low_confidence'
    | 'missing_capability'
    | 'recovery_needed'
    | 'max_retries_exceeded'
    // §23 — formal escalation triggers
    | 'high_value_action'
    | 'irreversible_action'
    | 'novel_pattern'
    | 'confidence_below_threshold'
    | 'cross_boundary'
    | 'capability_expansion'

// ---------------------------------------------------------------------------
// Plan & Steps
// ---------------------------------------------------------------------------

export interface ToolCall {
    tool: string
    params: Record<string, unknown>
}

export interface PlanStep {
    id: string
    description: string
    toolCall?: ToolCall
    /** If true, requires approval before execution */
    oneWayDoor?: OneWayDoor
    dependsOn?: string[]
    /** §23 — Escalation trigger type, if this step requires escalation */
    escalationTrigger?: EscalationTrigger
}

export interface Plan {
    steps: PlanStep[]
    /** Estimated total duration in seconds */
    estimatedSeconds?: number
    confidence: number
}

export interface StepResult {
    stepId: string
    ok: boolean
    output?: unknown
    error?: string
    durationMs: number
}

export interface ShouldActivateResult {
    activate: boolean
    confidence: number
    reasoning?: string
}

export interface EscalationResponse {
    approved: boolean
    feedback?: string
}

// ---------------------------------------------------------------------------
// Agent Contract Interface
// ---------------------------------------------------------------------------

export interface AgentExtension {
    /**
     * Called for every new task. Return { activate: true, confidence: 0–1 }
     * to claim the task. Host routes to highest-confidence claimant.
     */
    shouldActivate(task: { title: string; type: string; context?: unknown }): Promise<ShouldActivateResult>

    /**
     * Called if agent wins the routing competition.
     * Must return a plan — array of steps to execute.
     */
    plan(task: { title: string; type: string; context?: unknown }): Promise<Plan>

    /**
     * Called once per step by the host executor.
     */
    executeStep(step: PlanStep, context: { workspaceId: string; taskId: string }): Promise<StepResult>

    /**
     * Called after each step. Return { ok: true } to continue, { ok: false } to escalate.
     */
    verifyStep(result: StepResult): Promise<{ ok: boolean; reason?: string }>

    /**
     * §23 — Called when escalation is required.
     * Agent MUST pause and wait for host to relay user response.
     * Hosts MUST implement at minimum IRREVERSIBLE_ACTION and CAPABILITY_EXPANSION triggers.
     */
    onEscalation(reason: EscalationReason, context: unknown): Promise<EscalationResponse>
}
