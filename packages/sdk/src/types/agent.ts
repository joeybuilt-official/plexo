// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel Agent Contract Types
 * Corresponds to §8 of the Kapsel Protocol Specification v0.2.0
 */

export type OneWayDoorType =
    | 'irreversible_action'
    | 'external_write'
    | 'financial_transaction'
    | 'data_deletion'
    | 'permission_escalation'

export type EscalationReason =
    | 'ambiguous_goal'
    | 'one_way_door'
    | 'low_confidence'
    | 'missing_capability'
    | 'recovery_needed'
    | 'max_retries_exceeded'

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
     * Called when escalation is required (one-way door, low confidence, etc.)
     * Agent should pause and wait for host to relay user response.
     */
    onEscalation?(reason: EscalationReason, context: unknown): Promise<EscalationResponse>
}
