// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connection & Profile Standard (ADR 0001 §3) — server-side profile negotiation.
 *
 * An app declares a requestedProfile; the server computes the EFFECTIVE profile
 * as intersection(requested, granted) and returns it. The grant lives in
 * workspace_app_grants (operator-managed, default-deny). The app's request is
 * never authoritative.
 *
 * Grant row semantics:
 *   - status 'pending'  — the app has asked; allowed_connectors/capabilities hold
 *                         the REQUESTED scope as a proposal for the operator to
 *                         approve. Effective profile is empty (nothing granted yet).
 *   - status 'granted'  — operator-approved; allowed_connectors/capabilities are
 *                         the granted scope. Effective = intersection(requested, granted).
 *   - status 'revoked'  — explicitly denied; effective empty.
 */
import { db, eq, and } from '@plexo/db'
import { workspaceAppGrants } from '@plexo/db'
import { resolveEffectiveProfile, isConnectorAllowed, isCapabilityAllowed, type Profile } from '@plexo/agent/profile/resolve'

/** 403-class error code for an in-scope violation at runtime (ADR 0001 §3, P6). */
export const PROFILE_SCOPE_EXCEEDED = 'PROFILE_SCOPE_EXCEEDED'

export class ProfileScopeError extends Error {
    readonly code = PROFILE_SCOPE_EXCEEDED
    readonly status = 403
    constructor(message: string) {
        super(message)
        this.name = 'ProfileScopeError'
    }
}

export interface NegotiationResult {
    appId: string
    workspaceId: string
    status: 'granted' | 'pending' | 'revoked'
    effectiveProfile: Profile
}

const EMPTY: Profile = { connectors: [], capabilities: [] }

/**
 * Runtime guard for a single connector/capability access. Throws ProfileScopeError
 * (→ 403 PROFILE_SCOPE_EXCEEDED) when the effective profile does not permit it.
 * Used at every app→Plexo connector/capability call site (wired progressively in
 * 4d/4e); available now as the contract's enforcement primitive.
 */
export function assertInScope(profile: Profile, need: { connector?: string; capability?: string }): void {
    if (need.connector && !isConnectorAllowed(profile, need.connector)) {
        throw new ProfileScopeError(`connector '${need.connector}' is outside the granted profile`)
    }
    if (need.capability && !isCapabilityAllowed(profile, need.capability)) {
        throw new ProfileScopeError(`capability '${need.capability}' is outside the granted profile`)
    }
}

/**
 * Negotiate an app's effective profile in a workspace. Idempotent: when no grant
 * row exists, captures the request as a 'pending' proposal so it surfaces to the
 * operator; never grants anything by itself (default-deny).
 */
export async function negotiateProfile(params: {
    appId: string
    workspaceId: string
    requestedProfile?: Profile | null
}): Promise<NegotiationResult> {
    const { appId, workspaceId, requestedProfile } = params
    const reqConnectors = requestedProfile?.connectors ?? []
    const reqCapabilities = requestedProfile?.capabilities ?? []

    const [row] = await db
        .select({
            allowedConnectors: workspaceAppGrants.allowedConnectors,
            capabilities: workspaceAppGrants.capabilities,
            status: workspaceAppGrants.status,
        })
        .from(workspaceAppGrants)
        .where(and(eq(workspaceAppGrants.workspaceId, workspaceId), eq(workspaceAppGrants.appId, appId)))
        .limit(1)

    if (!row) {
        await db
            .insert(workspaceAppGrants)
            .values({
                appId,
                workspaceId,
                status: 'pending',
                allowedConnectors: reqConnectors,
                capabilities: reqCapabilities,
            })
            .onConflictDoNothing({ target: [workspaceAppGrants.appId, workspaceAppGrants.workspaceId] })
        return { appId, workspaceId, status: 'pending', effectiveProfile: { ...EMPTY } }
    }

    if (row.status === 'pending') {
        // Refresh the captured proposal with the latest request so the operator
        // approves what the app currently asks for.
        await db
            .update(workspaceAppGrants)
            .set({ allowedConnectors: reqConnectors, capabilities: reqCapabilities, updatedAt: new Date() })
            .where(and(eq(workspaceAppGrants.workspaceId, workspaceId), eq(workspaceAppGrants.appId, appId)))
        return { appId, workspaceId, status: 'pending', effectiveProfile: { ...EMPTY } }
    }

    if (row.status !== 'granted') {
        return { appId, workspaceId, status: 'revoked', effectiveProfile: { ...EMPTY } }
    }

    const granted: Profile = { connectors: row.allowedConnectors ?? [], capabilities: row.capabilities ?? [] }
    const effective = resolveEffectiveProfile(granted, requestedProfile)
    return { appId, workspaceId, status: 'granted', effectiveProfile: effective }
}
