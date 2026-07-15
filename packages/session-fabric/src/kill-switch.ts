// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric — global kill switch (Phase 1c, pure domain).
 *
 * When engaged, every mutating action is blocked fabric-wide. The runtime flag
 * lives behind `KillSwitchStore` (valkey adapter); the guard decision is pure.
 */

export interface KillSwitchState {
    engaged: boolean
    reason?: string | null
}

export type KillGuard = { allow: true } | { allow: false; reason: string }

export function killGuard(state: KillSwitchState): KillGuard {
    if (!state.engaged) return { allow: true }
    return { allow: false, reason: state.reason?.trim() || 'kill-switch engaged' }
}

/** Port: runtime kill-switch flag (valkey adapter at the edge). */
export interface KillSwitchStore {
    state(): Promise<KillSwitchState>
    engage(reason: string): Promise<void>
    release(): Promise<void>
}

/** Port: per-session drive grants (valkey adapter at the edge). */
export interface GrantStore {
    grant(sessionId: string, participantId: string, ttlSec: number): Promise<void>
    hasGrant(sessionId: string, participantId: string): Promise<boolean>
    revoke(sessionId: string, participantId: string): Promise<void>
}
