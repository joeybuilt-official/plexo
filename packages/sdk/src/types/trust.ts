// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §17 — Extension Trust Tiers
 * Plexo Fabric Specification v0.4.0
 *
 * Tier     | Who                                      | Capability Ceiling
 * ---------|------------------------------------------|------------------------------------
 * owner    | Built and signed by the host operator    | Full: memory:read:*, audit:read,
 *          |                                          | entity creation, model:override
 * verified | Reviewed and signed by Plexo extension registry   | Standard caps, no wildcard memory,
 *          |                                          | no audit access
 * community| Unreviewed public extensions             | Restricted caps, explicit user
 *          |                                          | approval per capability token
 *
 * Rules:
 *   - Hosts MUST declare trust tier policy in their compliance declaration
 *   - plexo.json MAY declare trust: 'owner' — host validates against signing key
 *   - Capability tokens exceeding declared tier MUST be rejected at install, not runtime
 */

export type TrustTier = 'owner' | 'verified' | 'community'

export interface TrustTierPolicy {
    /** Default tier for extensions without explicit trust declaration */
    defaultTier: TrustTier
    /** Whether the host enforces tier-based capability ceilings */
    enforceTierCeilings: boolean
    /** Signing key fingerprint for owner-tier validation */
    ownerSigningKeyId?: string
    /** Registry endpoint for verified-tier signature checks */
    registryEndpoint?: string
}

/**
 * Capability ceilings per trust tier.
 * Hosts use this to reject capabilities that exceed an extension's tier.
 */
export interface TrustTierCeilings {
    owner: {
        allowWildcardMemory: true
        allowAuditRead: true
        allowEntityCreation: true
        allowModelOverride: true
    }
    verified: {
        allowWildcardMemory: false
        allowAuditRead: false
        allowEntityCreation: true
        allowModelOverride: false
    }
    community: {
        allowWildcardMemory: false
        allowAuditRead: false
        allowEntityCreation: false
        allowModelOverride: false
    }
}
