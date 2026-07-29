// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension package signature verification.
 *
 * v1 strategy (documented in `docs/security/extension-security-model.md` §Q1):
 *
 *   Sigstore / cosign with GitHub OIDC — keyless signing tied to the GitHub
 *   Actions workflow that publishes to the registry. No long-lived keys to
 *   lose. The host verifies that the signature's signer identity resolves to
 *   `*@joeybuilt-official` (the owner) or to a key on the verified-publisher
 *   key set.
 *
 * This module ships a **stub** verifier for v1. The intent is:
 *
 *   - The registry stores signature metadata alongside every manifest row
 *     (`signature`, `signature_type`, `signer_identity`, `signed_at`) — see
 *     migration 0068.
 *   - Install-time, the host calls `verifySignature(manifest, meta)` and, on
 *     success, trusts the manifest's declared `trust` value.
 *   - On failure (or `null` meta), the host downgrades `trust` to `community`
 *     (for registry installs) or `local` (for sideloads), exactly as §8.4 of
 *     the security spec requires.
 *
 * The real verifier will call `cosign verify` against the Rekor log, or fall
 * back to a local ECDSA P-256 public key check. For v1 we accept any Sigstore
 * metadata whose `signer_identity` ends in `@joeybuilt-official` — this lets
 * us wire the call sites now and swap the implementation later without
 * churning the install route.
 */

import type { ExtensionManifest } from '../types/manifest.js'
import type { TrustTier } from '../types/trust.js'

export type SignatureType = 'sigstore' | 'ecdsa-p256' | 'none'

export interface SignatureMetadata {
    /** Opaque signature payload (base64 for ECDSA, JSON bundle for Sigstore). */
    signature: string
    /** Discriminator for which verifier to use. */
    signatureType: SignatureType
    /** Human-readable signer identity (e.g. `plexo-bot@joeybuilt-official`). */
    signerIdentity: string
    /** ISO 8601 timestamp the signature was produced. */
    signedAt: string
}

export interface SignatureVerificationResult {
    ok: boolean
    /** Matches the input `signatureType` on success, `'none'` on failure. */
    signatureType: SignatureType
    /** Signer identity extracted from the verified signature, if any. */
    signerIdentity: string | null
    /** The effective trust tier AFTER verification. May downgrade to 'community'. */
    effectiveTrust: TrustTier
    /** Human-readable message for the UI. */
    message: string
}

/**
 * The set of signer identity suffixes that qualify as "owner" for v1.
 * Extend this list — or replace the whole check with a real cosign call —
 * when the publishing pipeline is wired to GitHub OIDC.
 */
const OWNER_IDENTITY_SUFFIXES = ['@joeybuilt-official', '@plexo-official']

/**
 * Verify a manifest's signature. v1 stub behavior:
 *
 *   - `meta === null`               → unsigned, downgrade to `community`
 *   - `signatureType === 'none'`    → unsigned, downgrade to `community`
 *   - `signatureType === 'sigstore'`:
 *        - signer_identity endsWith an OWNER_IDENTITY_SUFFIX → accept as `owner`
 *        - otherwise                                          → accept as `verified`
 *   - `signatureType === 'ecdsa-p256'`:
 *        - accept as `verified` (real verification TBD)
 *
 * The declared `manifest.trust` is the ceiling — we never upgrade above it.
 * An unsigned extension claiming `owner` is downgraded to `community`. A
 * signed extension claiming `community` stays at `community`.
 */
export function verifySignature(
    manifest: ExtensionManifest,
    meta: SignatureMetadata | null,
): SignatureVerificationResult {
    const declared: TrustTier = (manifest.trust as TrustTier | undefined) ?? 'community'

    if (!meta || meta.signatureType === 'none' || !meta.signature) {
        if (declared === 'owner' || declared === 'verified') {
            return {
                ok: false,
                signatureType: 'none',
                signerIdentity: null,
                effectiveTrust: 'community',
                message: `Manifest declares trust "${declared}" but is unsigned — downgraded to community.`,
            }
        }
        return {
            ok: true,
            signatureType: 'none',
            signerIdentity: null,
            effectiveTrust: 'community',
            message: 'Unsigned community extension.',
        }
    }

    // Sigstore / cosign keyless (v1 stub: accept any identity)
    if (meta.signatureType === 'sigstore') {
        const isOwner = OWNER_IDENTITY_SUFFIXES.some((suffix) =>
            meta.signerIdentity.toLowerCase().endsWith(suffix),
        )
        const ceiling: TrustTier = isOwner ? 'owner' : 'verified'
        const effectiveTrust = lowerOf(declared, ceiling)
        return {
            ok: true,
            signatureType: 'sigstore',
            signerIdentity: meta.signerIdentity,
            effectiveTrust,
            message: `Sigstore signature accepted (stub v1) — signer ${meta.signerIdentity}.`,
        }
    }

    // Local ECDSA P-256 fallback (v1 stub)
    if (meta.signatureType === 'ecdsa-p256') {
        const effectiveTrust = lowerOf(declared, 'verified')
        return {
            ok: true,
            signatureType: 'ecdsa-p256',
            signerIdentity: meta.signerIdentity,
            effectiveTrust,
            message: `ECDSA signature accepted (stub v1) — signer ${meta.signerIdentity}.`,
        }
    }

    return {
        ok: false,
        signatureType: 'none',
        signerIdentity: null,
        effectiveTrust: 'community',
        message: `Unknown signature type: ${String((meta as SignatureMetadata).signatureType)}`,
    }
}

/** Returns the more restrictive of the two trust tiers. */
function lowerOf(a: TrustTier, b: TrustTier): TrustTier {
    const order: Record<TrustTier, number> = { community: 0, verified: 1, owner: 2 }
    return order[a] <= order[b] ? a : b
}
