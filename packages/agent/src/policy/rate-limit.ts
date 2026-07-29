// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Combined per-app + per-workspace token-bucket rate limiter (door #6 of
 * ADR 0010). Default: burst 100, refill 100 tokens/min.
 *
 * Bucket key = `${workspaceId}:${appId}`. One bucket per (workspace, app)
 * pair so a runaway extension at workspace A doesn't stall workspace B.
 *
 * Day-1 prerequisites (per ADR 0010 door #6):
 *   - Per-app override mechanism: callers pass `getOverride(...)` that
 *     returns `{ burst, refillPerMin }` for non-default apps. Default
 *     impl returns null → 100/100 applies.
 *   - Bulk-import exemption: `consumeBulkImport()` increments an audit-
 *     only counter and returns immediately. Used by the Phase 7 corpus
 *     migration's `add_fact_triple` bypass route — operations there can
 *     burn tokens 1000× faster than the per-write path and would
 *     instant-throttle without an exemption.
 *
 * In-process Map storage. Single-instance scope is correct for the sidecar
 * + apps/api process today; if the policy module ever runs across
 * processes, swap the storage strategy for Redis-backed buckets without
 * changing the public surface.
 */

import { emitPolicySignal } from './signals.js'
import type { PolicyCaller } from './types.js'

export interface RateLimitOptions {
    burst: number
    refillPerMin: number
}

export interface RateLimitDecision {
    allowed: boolean
    remaining: number
    retryAfterMs?: number
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { burst: 100, refillPerMin: 100 }

export type RateLimitOverrideFn = (workspaceId: string, appId: string) => RateLimitOptions | null

interface Bucket {
    tokens: number
    lastRefillAt: number
    cap: number
    refillRatePerMs: number
}

export class RateLimiter {
    private readonly buckets = new Map<string, Bucket>()
    private bulkImportAudit = 0
    constructor(private readonly getOverride: RateLimitOverrideFn = () => null) {}

    consume(caller: PolicyCaller, cost: number = 1, now: number = Date.now()): RateLimitDecision {
        const key = `${caller.workspaceId}:${caller.appId}`
        const opts = this.getOverride(caller.workspaceId, caller.appId) ?? DEFAULT_RATE_LIMIT
        const refillRatePerMs = opts.refillPerMin / 60_000
        let bucket = this.buckets.get(key)
        if (!bucket) {
            bucket = { tokens: opts.burst, lastRefillAt: now, cap: opts.burst, refillRatePerMs }
            this.buckets.set(key, bucket)
        } else {
            // Cap + rate may have changed via override; re-pin without losing accumulated tokens above the new cap.
            bucket.cap = opts.burst
            bucket.refillRatePerMs = refillRatePerMs
            const elapsed = Math.max(0, now - bucket.lastRefillAt)
            bucket.tokens = Math.min(bucket.cap, bucket.tokens + elapsed * bucket.refillRatePerMs)
            bucket.lastRefillAt = now
        }

        if (bucket.tokens >= cost) {
            bucket.tokens -= cost
            return { allowed: true, remaining: Math.floor(bucket.tokens) }
        }

        const deficit = cost - bucket.tokens
        const retryAfterMs = bucket.refillRatePerMs > 0 ? Math.ceil(deficit / bucket.refillRatePerMs) : Number.POSITIVE_INFINITY
        emitPolicySignal({
            kind: 'rate_limit_throttled',
            workspaceId: caller.workspaceId,
            appId: caller.appId,
            at: new Date(now),
            reason: `tokens=${bucket.tokens.toFixed(2)} cost=${cost} retryAfterMs=${retryAfterMs}`,
        })
        return { allowed: false, remaining: Math.floor(bucket.tokens), retryAfterMs }
    }

    /** Bulk-import bypass — audit-only counter. Phase 7 corpus migration uses this. */
    consumeBulkImport(_caller: PolicyCaller, n: number = 1): void {
        this.bulkImportAudit += n
    }

    /** Test/observability hook. */
    getBulkImportAuditCount(): number { return this.bulkImportAudit }

    /** Test hook — drop all buckets. */
    reset(): void {
        this.buckets.clear()
        this.bulkImportAudit = 0
    }
}
