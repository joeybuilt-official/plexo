// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric — tier capability matrix (Phase 1c, pure domain).
 *
 * observe = read-only · steer = approve/deny + send a message ·
 * drive = mutating (append arbitrary events, claim/renew a lease, join as driver).
 * Framework-free: no IO, no imports outside the contract.
 */

import type { PolicyTier } from './contract'
import type { SessionEventKind } from './contract'

export type Tier = PolicyTier

/** Coarse capability an incoming action requests. */
export type ActionKind = 'read' | 'message' | 'approve' | 'mutate'

const TIER_RANK: Record<Tier, number> = { observe: 0, steer: 1, drive: 2 }

const ACTION_MIN_TIER: Record<ActionKind, Tier> = {
    read: 'observe',
    message: 'steer',
    approve: 'steer',
    mutate: 'drive',
}

/** True when `tier` is at least the minimum tier required for `action`. */
export function tierAllows(tier: Tier, action: ActionKind): boolean {
    return TIER_RANK[tier] >= TIER_RANK[ACTION_MIN_TIER[action]]
}

/** True when `tier` is at least `required` in the observe→steer→drive order. */
export function tierAtLeast(tier: Tier, required: Tier): boolean {
    return TIER_RANK[tier] >= TIER_RANK[required]
}

/**
 * Minimum tier required to APPEND an event of the given kind.
 * A steerer may send messages and record approval decisions; everything a
 * runner emits while driving (tool calls, plans, status, outcomes) needs drive.
 */
export function eventKindMinTier(kind: SessionEventKind): Tier {
    switch (kind) {
        case 'message':
        case 'approval_request':
        case 'approval_decision':
            return 'steer'
        default:
            return 'drive'
    }
}
