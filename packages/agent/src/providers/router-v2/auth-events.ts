// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — auth-failure tracking + structured ops-event emission.
 *
 * ADR 0012 §C3: auth failures cascade silently at call-time; this module
 * accumulates per-(workspaceId, providerId) state so the workspace settings
 * page can render a badge after 3 consecutive auth failures within 24h.
 *
 * `auth_failure` events are emitted on every auth-class error and carry the
 * full payload — consumers decide what to surface.
 */

import type { ProviderKey } from '../registry.js'
import { emitProviderFailure } from './ops-events.js'

const WINDOW_24H_MS = 24 * 60 * 60 * 1000
const BADGE_THRESHOLD = 3

interface Bucket {
    consecutiveFailures: number
    lastSuccessAt: number  // 0 if never observed
    lastFailureAt: number  // 0 if never observed
    lastModelId: string | undefined
    lastStatusCode: number | undefined
}

export interface AuthBadgeState {
    consecutiveFailures: number
    lastSuccessAt: number
    lastFailureAt: number
    lastModelId: string | undefined
    lastStatusCode: number | undefined
    /** True iff ≥3 consecutive failures within the trailing 24h window. */
    shouldShowBadge: boolean
}

export interface AuthFailureEvent {
    event: 'auth_failure'
    workspaceId: string | undefined
    providerId: ProviderKey
    modelId: string
    statusCode: number | undefined
    lastSuccessAt: number
    consecutiveFailures: number
}

const store = new Map<string, Bucket>()

function keyOf(workspaceId: string | undefined, providerId: ProviderKey): string {
    return `${workspaceId ?? '*'}|${providerId}`
}

function freshBucket(): Bucket {
    return {
        consecutiveFailures: 0,
        lastSuccessAt: 0,
        lastFailureAt: 0,
        lastModelId: undefined,
        lastStatusCode: undefined,
    }
}

/** Extract an HTTP status code from a provider error message; undefined if unparseable. */
export function extractStatusCode(message: string): number | undefined {
    const m = message.match(/\b(4\d{2}|5\d{2})\b/)
    if (!m) return undefined
    const code = parseInt(m[1]!, 10)
    return Number.isFinite(code) ? code : undefined
}

export function recordAuthFailure(input: {
    workspaceId: string | undefined
    providerId: ProviderKey
    modelId: string
    errorMessage: string
}): void {
    const { workspaceId, providerId, modelId, errorMessage } = input
    const now = Date.now()
    const statusCode = extractStatusCode(errorMessage)
    const k = keyOf(workspaceId, providerId)
    let b = store.get(k)
    if (!b) {
        b = freshBucket()
        store.set(k, b)
    }
    // If the last failure was outside the 24h window, the streak resets to 1.
    if (b.lastFailureAt > 0 && now - b.lastFailureAt > WINDOW_24H_MS) {
        b.consecutiveFailures = 0
    }
    b.consecutiveFailures += 1
    b.lastFailureAt = now
    b.lastModelId = modelId
    b.lastStatusCode = statusCode

    const evt: AuthFailureEvent = {
        event: 'auth_failure',
        workspaceId,
        providerId,
        modelId,
        statusCode,
        lastSuccessAt: b.lastSuccessAt,
        consecutiveFailures: b.consecutiveFailures,
    }
    // TODO(Phase 5): replace with real telemetry sink (Helm / PostHog / OTel).
    console.info(JSON.stringify(evt))

    // Fire a provider-failure ops event once, exactly when the streak first
    // crosses the badge threshold — avoids alerting on every subsequent failure.
    if (b.consecutiveFailures === BADGE_THRESHOLD) {
        emitProviderFailure({
            kind: 'auth_failure_streak',
            workspaceId,
            provider: providerId,
            consecutiveFailures: b.consecutiveFailures,
            statusCode,
        })
    }
}

export function recordAuthSuccess(input: {
    workspaceId: string | undefined
    providerId: ProviderKey
}): void {
    const { workspaceId, providerId } = input
    const k = keyOf(workspaceId, providerId)
    let b = store.get(k)
    if (!b) {
        b = freshBucket()
        store.set(k, b)
    }
    b.consecutiveFailures = 0
    b.lastSuccessAt = Date.now()
}

export function getAuthBadgeState(
    workspaceId: string | undefined,
    providerId: ProviderKey,
): AuthBadgeState {
    const b = store.get(keyOf(workspaceId, providerId))
    if (!b) {
        return {
            consecutiveFailures: 0,
            lastSuccessAt: 0,
            lastFailureAt: 0,
            lastModelId: undefined,
            lastStatusCode: undefined,
            shouldShowBadge: false,
        }
    }
    const now = Date.now()
    // Stale streak (older than 24h) does not warrant a badge.
    const recentStreak = b.lastFailureAt > 0 && now - b.lastFailureAt <= WINDOW_24H_MS
    const shouldShowBadge = recentStreak && b.consecutiveFailures >= BADGE_THRESHOLD
    return {
        consecutiveFailures: b.consecutiveFailures,
        lastSuccessAt: b.lastSuccessAt,
        lastFailureAt: b.lastFailureAt,
        lastModelId: b.lastModelId,
        lastStatusCode: b.lastStatusCode,
        shouldShowBadge,
    }
}

/** Test-only — wipe all auth-event state. */
export function _resetAuthEventsForTest(): void {
    store.clear()
}
