// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * DENY-by-default cross-app read filter (door #5 of ADR 0010).
 *
 * Filters a list of policy-shaped Graphiti edges down to the subset the
 * caller is allowed to see. Rules, in order:
 *
 *   1. Edge with no `callerApp` attribution → ALLOWED. Pre-Phase-5 corpus
 *      rows lack the field; we don't retroactively quarantine them.
 *   2. Edge written by the caller's own app → ALLOWED.
 *   3. Edge's `callerApp` is in the workspace's `allowedApps` set for the
 *      caller's app → ALLOWED.
 *   4. Otherwise → DENIED (and a `cross_app_deny` signal fires).
 *
 * `allowedApps` is fetched per-request by the route layer that constructs
 * the call (it doesn't live in this module). Today the workspace-cross-app
 * grants table doesn't exist yet — callers should pass an empty set, which
 * yields a strict DENY across app boundaries until the Pex onboarding
 * UX lands the table + UI.
 */

import { emitPolicySignal } from './signals.js'
import type { PolicyCaller, PolicyEdge } from './types.js'

export interface CrossAppFilterContext extends PolicyCaller {
    /**
     * Set of `callerApp` values that this caller is permitted to read.
     * Empty = strict DENY across app boundaries (the Phase 4 default).
     * Populated by the future Pex onboarding cross-app scope checkbox UX.
     */
    allowedApps: ReadonlySet<string>
}

export interface CrossAppFilterResult {
    allowed: PolicyEdge[]
    denied: PolicyEdge[]
}

export function applyCrossAppFilter(edges: readonly PolicyEdge[], ctx: CrossAppFilterContext): CrossAppFilterResult {
    const allowed: PolicyEdge[] = []
    const denied: PolicyEdge[] = []
    for (const e of edges) {
        if (e.callerApp === null) { allowed.push(e); continue }
        if (e.callerApp === ctx.appId) { allowed.push(e); continue }
        if (ctx.allowedApps.has(e.callerApp)) { allowed.push(e); continue }
        denied.push(e)
    }
    if (denied.length > 0) {
        emitPolicySignal({
            kind: 'cross_app_deny',
            workspaceId: ctx.workspaceId,
            appId: ctx.appId,
            at: new Date(),
            reason: `${denied.length} edge(s) from non-allowed app(s)`,
            count: denied.length,
        })
    }
    return { allowed, denied }
}
