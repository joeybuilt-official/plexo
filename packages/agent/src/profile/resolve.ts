// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connection & Profile Standard (ADR 0001 §3) — pure profile resolution.
 *
 * A Profile is the (connectors, capabilities) pair an app may use within a
 * workspace. The grant lives server-side (workspace_app_grants); the app's
 * connect() request is advisory. The EFFECTIVE profile the app actually gets is
 * the intersection of what it requested with what the operator granted:
 *
 *     effective = intersection(requestedProfile, grantedProfile)
 *
 * Default-deny is enforced at the LOADER (no grant row → EMPTY_PROFILE → nothing
 * allowed). This module is pure (no DB, no IO) so it is trivially testable and
 * shared between the executor's tool-load enforcement (§3 "every call") and the
 * server's connect() negotiation.
 */

export interface Profile {
    connectors: string[]
    capabilities: string[]
}

/** Default-deny result: an app with no grant gets nothing. */
export const EMPTY_PROFILE: Profile = { connectors: [], capabilities: [] }

function uniq(xs: string[]): string[] {
    return [...new Set(xs)]
}

/**
 * Does `granted` permit `token`?
 *
 * Plain equality, plus the manifest wildcard forms (ADR reuses the
 * packages/sdk capability vocabulary):
 *   - a granted `*` matches anything (owner-tier grant)
 *   - a granted `prefix:*` matches any token sharing that prefix
 *     (e.g. `memory:read:*` grants `memory:read:person`)
 *
 * Connectors carry no wildcards in practice, so for them this collapses to
 * exact match — which is the intended behavior.
 */
function grantedMatches(granted: string, token: string): boolean {
    if (granted === token) return true
    if (granted === '*') return true
    if (granted.endsWith(':*')) {
        const prefix = granted.slice(0, -1) // keep trailing ':'
        return token.startsWith(prefix)
    }
    return false
}

function intersect(requested: string[], granted: string[]): string[] {
    return uniq(requested.filter((r) => granted.some((g) => grantedMatches(g, r))))
}

/**
 * Compute the effective profile.
 *
 * - `granted` absent → EMPTY_PROFILE (default-deny).
 * - `requested` absent → the app did not narrow its scope, so it receives the
 *   full grant (effective = granted). This keeps the executor path — where a
 *   task carries no explicit per-call request — working within the grant.
 * - both present → intersection. Tokens the app requests that are not granted
 *   are dropped silently (the request is never authoritative). Granted tokens
 *   the app did not request are also dropped (least-privilege for this session).
 */
export function resolveEffectiveProfile(granted?: Profile | null, requested?: Profile | null): Profile {
    if (!granted) return { ...EMPTY_PROFILE }
    if (!requested) {
        return { connectors: uniq(granted.connectors), capabilities: uniq(granted.capabilities) }
    }
    return {
        connectors: intersect(requested.connectors, granted.connectors),
        capabilities: intersect(requested.capabilities, granted.capabilities),
    }
}

/** Is a specific connector (registryId, e.g. "github") in the effective profile? */
export function isConnectorAllowed(profile: Profile, connectorId: string): boolean {
    return profile.connectors.some((g) => grantedMatches(g, connectorId))
}

/** Is a specific capability token in the effective profile? */
export function isCapabilityAllowed(profile: Profile, capability: string): boolean {
    return profile.capabilities.some((g) => grantedMatches(g, capability))
}
