// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pex extension quarantine (door #7 of ADR 0010).
 *
 * New Pex extensions land in a sandboxed `quarantine:<workspaceId>:<extId>`
 * namespace for a trial period that depends on trust tier. During trial,
 * their writes go to the quarantine namespace and are NOT joined into the
 * workspace's primary memory until the operator (or telemetry-driven
 * promotion gate) signs off.
 *
 * Trial-duration table:
 *   signed     → 0 days  (trusted publisher; no quarantine)
 *   unverified → 7 days
 *   new        → 30 days
 *
 * Per ADR 0010 door #7: real telemetry-driven promotion signals are defined
 * in the Pex framework design, not here. This module ships the namespace
 * shape + trial-duration math + a stub `evaluatePromotion()` that always
 * returns "wait" (operator-only promotion until Pex signals land).
 */

import type { TrustTier } from './types.js'

export const TRIAL_DURATION_DAYS: Record<TrustTier, number> = {
    signed: 0,
    unverified: 7,
    new: 30,
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

const NAMESPACE_RE = /^quarantine:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/i

export function quarantineNamespace(workspaceId: string, extId: string): string {
    if (!/^[a-z0-9._-]+$/i.test(extId)) {
        throw new Error(`extId must match [a-z0-9._-]+ (got: ${extId})`)
    }
    return `quarantine:${workspaceId}:${extId}`
}

export function parseQuarantineNamespace(ns: string): { workspaceId: string; extId: string } | null {
    const m = NAMESPACE_RE.exec(ns)
    if (!m) return null
    return { workspaceId: m[1]!, extId: m[2]! }
}

export function trialEndsAt(tier: TrustTier, joinedAt: Date): Date {
    return new Date(joinedAt.getTime() + TRIAL_DURATION_DAYS[tier] * MS_PER_DAY)
}

export function isInTrial(tier: TrustTier, joinedAt: Date, now: Date = new Date()): boolean {
    if (tier === 'signed') return false
    return now < trialEndsAt(tier, joinedAt)
}

export type PromotionVerdict = 'promote' | 'reject' | 'wait'

/**
 * Stub: returns 'wait' until the Pex framework wires real telemetry signals.
 * Operators promote by external action (CLI / dashboard). When telemetry
 * lands, this function consumes signal aggregates and returns 'promote' /
 * 'reject' on its own.
 */
export function evaluatePromotion(_args: {
    tier: TrustTier
    joinedAt: Date
    now?: Date
}): PromotionVerdict {
    return 'wait'
}
