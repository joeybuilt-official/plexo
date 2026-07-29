// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo memory-layer policy module (Phase 4 of `graphiti-migration/plan.md`).
 * Wraps three independent gates around Graphiti reads and writes:
 *
 *   - cross-app-filter — DENY-by-default reads across app boundaries
 *   - rate-limit       — combined per-app + per-workspace token bucket
 *   - quarantine       — Pex namespace + trust-tiered trial durations
 *
 * Each submodule is consumable independently; the typical request path
 * threads them in this order:
 *
 *   1. RateLimiter.consume(caller) — short-circuit on 429
 *   2. Graphiti.search(...)        — fetch raw edges
 *   3. applyCrossAppFilter(edges)  — strip cross-app reads
 *
 * Quarantine logic only fires on Pex-extension writes; the policy gate
 * routes those to `quarantineNamespace()` instead of the workspace's
 * primary group_id.
 */

export { applyCrossAppFilter } from './cross-app-filter.js'
export type { CrossAppFilterContext, CrossAppFilterResult } from './cross-app-filter.js'

export { RateLimiter, DEFAULT_RATE_LIMIT } from './rate-limit.js'
export type { RateLimitOptions, RateLimitDecision, RateLimitOverrideFn } from './rate-limit.js'

export {
    TRIAL_DURATION_DAYS,
    quarantineNamespace,
    parseQuarantineNamespace,
    trialEndsAt,
    isInTrial,
    evaluatePromotion,
} from './quarantine.js'
export type { PromotionVerdict } from './quarantine.js'

export { setPolicySignalEmitter, emitPolicySignal } from './signals.js'
export type { PolicySignal, PolicySignalKind } from './signals.js'

export type { PolicyCaller, PolicyEdge, TrustTier } from './types.js'
