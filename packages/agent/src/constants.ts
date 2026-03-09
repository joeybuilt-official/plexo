// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Safety limits — constants, not configuration.
 * These are never overridable at runtime.
 */
export const SAFETY_LIMITS = {
    maxConsecutiveToolCalls: 4,
    maxWallClockMs: 2 * 60 * 60 * 1000, // 2 hours
    maxRetries: 3,
    MAX_PLAN_STEPS: 20,
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
} as const
