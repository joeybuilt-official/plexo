// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — provider-failure ops-event sink (Phase 4 observability).
 *
 * The router runs in the agent layer, which must not import the API analytics
 * relay. Instead the API registers a sink at startup; the router fires events
 * into it on the two failure signals worth alerting on:
 *   - cascade_exhausted   — every candidate provider failed for one call
 *   - auth_failure_streak — a provider crossed the consecutive-auth-failure
 *                           badge threshold (repeated auth/quota)
 *
 * Best-effort and decoupled: with no sink registered, emit is a no-op.
 */

export interface ProviderFailureEvent {
    kind: 'cascade_exhausted' | 'auth_failure_streak'
    workspaceId: string | undefined
    /** Provider key (e.g. the primary that started the cascade, or the failing provider). */
    provider: string
    taskType?: string
    /** auth_failure_streak only — the consecutive-failure count at the crossing. */
    consecutiveFailures?: number
    /** auth_failure_streak only — parsed HTTP status, if any. */
    statusCode?: number
    /** cascade_exhausted only — providers skipped during the cascade. */
    skipped?: string[]
    /** Truncated last error message (already ≤200 chars at the call sites). */
    lastError?: string
}

type Sink = (evt: ProviderFailureEvent) => void

let sink: Sink | null = null

/** Register (or clear, with null) the process-wide provider-failure sink. */
export function setProviderFailureSink(fn: Sink | null): void {
    sink = fn
}

/** Fire a provider-failure event into the registered sink. No-op if unset. */
export function emitProviderFailure(evt: ProviderFailureEvent): void {
    if (!sink) return
    try { sink(evt) } catch { /* best-effort — never throw on the failure path */ }
}
