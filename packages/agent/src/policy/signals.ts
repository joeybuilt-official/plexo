// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Policy-layer telemetry signals. Phase 4 ships the shape; the Pex framework
 * design (separate ADR, post-Phase-9) replaces the no-op emitter with the
 * real signal pipeline.
 *
 * Why a setter instead of a hard import: the policy module is consumed by
 * both `apps/api` and the Graphiti sidecar's TS bridge tests; the real
 * emitter (analytics + Pex) lives upstream and shouldn't backflow into
 * `@plexo/agent` as a hard dep.
 */

export type PolicySignalKind =
    | 'cross_app_deny'
    | 'rate_limit_throttled'
    | 'quarantine_promote'
    | 'quarantine_reject'

export interface PolicySignal {
    kind: PolicySignalKind
    workspaceId: string
    appId: string
    at: Date
    reason: string
    count?: number
}

type Emitter = (sig: PolicySignal) => void

let _emitter: Emitter | null = null

export function setPolicySignalEmitter(emit: Emitter | null): void {
    _emitter = emit
}

export function emitPolicySignal(sig: PolicySignal): void {
    if (_emitter) _emitter(sig)
}
