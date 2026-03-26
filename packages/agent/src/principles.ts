// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Governing Principles — encoded as code, not prompts.
 *
 * These are hard guardrails that the classifier, planner, and executor
 * enforce at the code level. They cannot be overridden by prompt
 * engineering, model quirks, or user confusion.
 *
 * Principle 1: SMALLEST POSSIBLE ACTION
 *   Default to the smallest action that satisfies the request.
 *   Only escalate scope when the user explicitly asks for more.
 *
 * Principle 2: NO INFRASTRUCTURE ASSUMPTIONS
 *   Work with what exists. Don't create tasks that require unconfigured
 *   services (repos, channels, providers).
 *
 * Principle 3: PROPORTIONAL PLANNING
 *   Plan complexity must be proportional to request complexity.
 *   A 10-word request never gets an 8-task plan.
 *
 * Principle 4: FAIL VISIBLE, FAIL FAST
 *   If something can't work, surface it in under 2 seconds with
 *   a specific fix action — don't queue tasks that will fail later.
 *
 * Principle 5: USER IS NOT A PROJECT MANAGER
 *   The agent never makes the user triage, coordinate, or debug
 *   the agent's own planning decisions.
 */

// ── Principle 1: Smallest Possible Action ────────────────────────────────────

/**
 * Hard-coded signals that force TASK classification regardless of model output.
 * These are structural patterns — the model can't override them.
 */
const PROJECT_REQUIRED_SIGNALS = [
    'project', 'initiative', 'multi-phase', 'multi-step',
    'workstreams', 'parallel tracks',
]

/**
 * Returns true only if the message explicitly describes multiple independent
 * deliverables. A single "create X" never qualifies, no matter how complex X sounds.
 */
export function requiresProjectScope(message: string): boolean {
    const lower = message.toLowerCase()
    // Must contain at least one explicit project signal
    const hasProjectSignal = PROJECT_REQUIRED_SIGNALS.some(s => lower.includes(s))
    if (!hasProjectSignal) return false

    // Must describe multiple independent deliverables (3+ "and"-separated items or explicit enumeration)
    const andCount = (lower.match(/\band\b/g) || []).length
    const commaListCount = (lower.match(/,\s*\w+/g) || []).length
    return andCount >= 2 || commaListCount >= 3
}

/**
 * Override classifier output when the message is clearly a single-deliverable request.
 * Called AFTER the LLM classifier runs. Returns the corrected intent.
 */
export function enforceSmallestAction(
    classifierResult: 'TASK' | 'PROJECT' | 'CONVERSATION',
    message: string,
): 'TASK' | 'PROJECT' | 'CONVERSATION' {
    if (classifierResult !== 'PROJECT') return classifierResult
    // If the classifier said PROJECT but the message doesn't have explicit project signals,
    // downgrade to TASK. The user can always escalate.
    if (!requiresProjectScope(message)) return 'TASK'
    return 'PROJECT'
}

// ── Principle 2: No Infrastructure Assumptions ───────────────────────────────

export interface WorkspaceCapabilities {
    hasRepo: boolean
    hasAIProvider: boolean
    hasChannel: boolean
    hasConnections: string[]  // list of connected service IDs
}

/**
 * Pre-flight check before task/project creation.
 * Returns null if ready, or a user-facing error with fix action if not.
 */
export function preflightCheck(
    taskType: string,
    capabilities: WorkspaceCapabilities,
): { error: string; fixUrl: string; fixLabel: string } | null {
    if (!capabilities.hasAIProvider) {
        return {
            error: 'No AI provider configured. Add one to get started.',
            fixUrl: '/settings/ai-providers',
            fixLabel: 'Configure AI Provider',
        }
    }

    if (taskType === 'coding' && !capabilities.hasRepo) {
        return {
            error: 'No repository connected. Coding tasks need a repo to work against.',
            fixUrl: '/connections?highlight=github',
            fixLabel: 'Connect GitHub',
        }
    }

    return null
}

// ── Principle 3: Proportional Planning ───────────────────────────────────────

/**
 * Determine the maximum number of sprint tasks based on request complexity.
 * Short requests get fewer tasks. This is a hard cap, not a suggestion.
 */
export function maxSprintTasks(request: string): number {
    const words = request.trim().split(/\s+/).length
    if (words <= 15) return 2
    if (words <= 30) return 3
    if (words <= 60) return 5
    return 8
}

// ── Principle 4: Fail Visible, Fail Fast ─────────────────────────────────────

/**
 * Known failure patterns and their user-facing resolutions.
 * Used by both the error presenter (UI) and the pre-flight check (API).
 */
export const KNOWN_FAILURES: Record<string, { message: string; fixUrl: string; fixLabel: string }> = {
    'no_ai_credential': {
        message: 'No AI provider configured.',
        fixUrl: '/settings/ai-providers',
        fixLabel: 'Add AI Provider',
    },
    'cost_ceiling': {
        message: 'Weekly cost ceiling reached.',
        fixUrl: '/settings/ai-providers',
        fixLabel: 'Adjust Budget',
    },
    'no_repo': {
        message: 'No repository connected for coding tasks.',
        fixUrl: '/connections?highlight=github',
        fixLabel: 'Connect GitHub',
    },
}
