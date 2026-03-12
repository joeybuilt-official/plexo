// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Safety limits — constants, not configuration.
 * These are never overridable at runtime.
 */
export const SAFETY_LIMITS = {
    maxConsecutiveToolCalls: 200,
    maxRetries: 5,
    MAX_PLAN_STEPS: 100,
    /** Stall detection: if no new tool calls are produced in this window, the task is stalled. */
    stallWindowMs: 10 * 60 * 1000, // 10 minutes with no progress
    /** Absolute ceiling — catch-all for runaway tasks. Well above normal. */
    maxWallClockMs: 24 * 60 * 60 * 1000, // 24 hours
    noForcePush: true,
    noDeletionWithoutConfirmation: true,
    noCredentialsInLogs: true,
} as const

export const MODEL_ROUTING = {
    default: 'claude-opus-4-5',
    planning: 'claude-opus-4-5',
    codeGeneration: 'claude-sonnet-4-5',
    verification: 'claude-sonnet-4-5',
    summarization: 'claude-haiku-4-5',
    classification: 'claude-haiku-4-5',
    logAnalysis: 'claude-haiku-4-5',
} as const

export const QUALITY_RUBRICS = {
    coding: [
        { dimension: 'build_passes', weight: 0.30 },
        { dimension: 'tests_pass', weight: 0.25 },
        { dimension: 'acceptance_met', weight: 0.25 },
        { dimension: 'no_scope_creep', weight: 0.10 },
        { dimension: 'no_todos_left', weight: 0.10 },
    ],
    deployment: [
        { dimension: 'health_check_passes', weight: 0.40 },
        { dimension: 'rollback_confirmed', weight: 0.30 },
        { dimension: 'no_regression', weight: 0.30 },
    ],
    research: [
        { dimension: 'sources_cited', weight: 0.25 },
        { dimension: 'claims_verifiable', weight: 0.25 },
        { dimension: 'actionable_output', weight: 0.30 },
        { dimension: 'scope_respected', weight: 0.20 },
    ],
    ops: [
        { dimension: 'operation_succeeded', weight: 0.40 },
        { dimension: 'state_confirmed', weight: 0.40 },
        { dimension: 'side_effects_logged', weight: 0.20 },
    ],
    writing: [
        { dimension: 'grammatically_correct', weight: 0.20 },
        { dimension: 'tone_appropriate', weight: 0.30 },
        { dimension: 'brief_followed', weight: 0.30 },
        { dimension: 'originality', weight: 0.20 },
    ],
    general: [
        { dimension: 'goal_met', weight: 0.60 },
        { dimension: 'conciseness', weight: 0.20 },
        { dimension: 'helpful_tone', weight: 0.20 },
    ],
    marketing: [
        { dimension: 'brand_alignment', weight: 0.30 },
        { dimension: 'cta_clarity', weight: 0.30 },
        { dimension: 'channel_optimization', weight: 0.20 },
        { dimension: 'strategic_intent', weight: 0.20 },
    ],
    data: [
        { dimension: 'accuracy', weight: 0.40 },
        { dimension: 'completeness', weight: 0.30 },
        { dimension: 'insightfulness', weight: 0.30 },
    ],
} as const
