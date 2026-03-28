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

// ── Principle 6: Conversational Override ─────────────────────────────────────
//
// Some messages are NEVER tasks, regardless of what the classifier thinks.
// These are detected at the code level and forced to CONVERSATION.

/** Messages that are clearly greetings, check-ins, or meta-communication — never tasks. */
const GREETING_PATTERNS = [
    /^(hey|hi|hello|yo|sup|what'?s up|howdy|good\s+(morning|afternoon|evening))[\s!?.,]*$/i,
    /^you\s+(there|up|around|working|ready|alive|online)[\s!?.,]*$/i,
    /^(still\s+(working|there)|ready\s+to\s+(rock|go|work)|what'?s\s+the\s+move)[\s!?.,]*$/i,
    /^(test(ing)?|ping|check)[\s!?.]*$/i,
    /^(thanks|thank\s+you|thx|ty|cool|ok|okay|got\s+it|nice|great|perfect|awesome|good)[\s!?.]*$/i,
]

/** Messages where the user explicitly refuses task creation. */
const REFUSAL_PATTERNS = [
    /don'?t\s+(create|make|start|queue)\s+(a\s+)?task/i,
    /no\s+task/i,
    /just\s+(send|give|show|tell|answer|respond|reply)/i,
    /don'?t\s+need\s+a\s+task/i,
    /not\s+a\s+task/i,
    /stop\s+creating\s+tasks/i,
    /just\s+do\s+it/i,
    /just\s+do\s+the\s+thing/i,
]

/**
 * Returns true if the message is a greeting, check-in, or meta-communication
 * that should never be classified as a TASK.
 */
export function isGreetingOrCheckin(message: string): boolean {
    return GREETING_PATTERNS.some(p => p.test(message.trim()))
}

/**
 * Returns true if the user is explicitly refusing task creation.
 */
export function isTaskRefusal(message: string): boolean {
    return REFUSAL_PATTERNS.some(p => p.test(message))
}

/**
 * Force CONVERSATION when the message is clearly conversational.
 * Called BEFORE the LLM classifier — short-circuits the entire classification pipeline.
 */
export function forceConversationOverride(message: string): boolean {
    return isGreetingOrCheckin(message) || isTaskRefusal(message)
}

// ── Principle 7: Correction Detection ────────────────────────────────────────
//
// Correction patterns are defined here (no DB dependency) so the classifier
// can check them without pulling in the full corrections module.

/** Patterns that signal the user is correcting or rejecting agent output. */
const CORRECTION_SIGNALS = [
    /that'?s\s+(wrong|incorrect|not\s+right|not\s+what)/i,
    /no,?\s+(actually|i\s+meant|i\s+said|i\s+asked)/i,
    /you\s+(misunderstood|got\s+it\s+wrong|missed)/i,
    /wrong\s+(answer|output|result|approach)/i,
    /try\s+again/i,
    /that\s+doesn'?t\s+(work|look\s+right|make\s+sense)/i,
    /not\s+what\s+i\s+(wanted|asked|meant)/i,
    /i\s+said\s+don'?t/i,
    /please\s+(fix|correct|redo|undo)/i,
    /start\s+over/i,
]

/**
 * Returns true if the message contains correction intent signals.
 */
export function hasCorrectionIntent(message: string): boolean {
    return CORRECTION_SIGNALS.some(p => p.test(message))
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
