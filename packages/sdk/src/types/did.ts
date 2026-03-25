// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §21 — Agent + Extension Identity via DID + Verifiable Credentials
 * Plexo Fabric Specification v0.4.0
 *
 * Each Extension and Agent MAY be assigned a W3C Decentralized Identifier (DID).
 * Full compliance hosts MUST assign DIDs for any cross-host interaction.
 *
 * Rules:
 *   - Extension and Agent DIDs resolvable via Extension Registry Protocol (§12)
 *   - Cross-host actions MUST be signed with the Extension's or Agent's private key
 *   - Revoked or expired VCs cause immediate capability rejection
 *   - Capability token: identity:present — required for cross-host interactions
 */

import type { TrustTier } from './trust.js'

/**
 * W3C DID Document fields for Plexo entities.
 * @example did:plexo:host-id:extension-id
 */
export interface PlexoDIDDocument {
    /** W3C DID string, e.g. 'did:plexo:host-id:extension-id' */
    did: string
    /** Public key for signing agent actions and authenticating */
    publicKey: string
    /** Communication endpoints */
    serviceEndpoints?: Record<string, string>
    /** URL that resolves to plexo.json */
    extensionManifest?: string
    /** Trust tier of this entity */
    trustTier: TrustTier
    /** DID of the issuing host or registry */
    issuedBy: string
}

/**
 * Verifiable Credential issued by a host at install time,
 * attesting to capability grants.
 */
export interface PlexoVerifiableCredential {
    /** Unique credential ID */
    id: string
    /** W3C VC type */
    type: 'VerifiableCredential' | 'PlexoCapabilityCredential'
    /** DID of the issuer (host) */
    issuer: string
    /** DID of the subject (extension or agent) */
    subject: string
    /** ISO 8601 issuance date */
    issuanceDate: string
    /** ISO 8601 expiration date */
    expirationDate?: string
    /** Granted capability tokens */
    capabilities: string[]
    /** Cryptographic proof */
    proof: {
        type: string
        created: string
        proofPurpose: string
        verificationMethod: string
        /** Signature value */
        jws: string
    }
}

/**
 * Selective disclosure request — prove a specific capability
 * without revealing all grants.
 */
export interface SelectiveDisclosureRequest {
    /** Capabilities the verifier wants proof of */
    requestedCapabilities: string[]
    /** DID of the requesting party */
    verifier: string
    /** Nonce to prevent replay */
    nonce: string
}

export interface SelectiveDisclosureResponse {
    /** Derived credential proving only requested capabilities */
    credential: PlexoVerifiableCredential
    /** Nonce from the request */
    nonce: string
}

/** @deprecated Use PlexoDIDDocument instead. */
export type KapselDIDDocument = PlexoDIDDocument
/** @deprecated Use PlexoVerifiableCredential instead. */
export type KapselVerifiableCredential = PlexoVerifiableCredential
