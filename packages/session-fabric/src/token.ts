// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric — device-token claims + pure claim verification (Phase 1c).
 *
 * The cryptographic sign/verify lives behind the `TokenSigner` port; this file
 * only owns the CLAIM SHAPE and the pure exp/shape check. The valkey-backed
 * revocation denylist lives behind `RevocationStore`. No jose, no IO here.
 */

import { z } from 'zod'
import { policyTier } from './contract'

export const deviceTokenClaims = z.object({
    deviceId: z.string().min(1).max(128),
    participantId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    tier: policyTier,
    jti: z.string().min(1).max(128),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
})

export type DeviceTokenClaims = z.infer<typeof deviceTokenClaims>

export type ClaimsResult =
    | { ok: true; claims: DeviceTokenClaims }
    | { ok: false; reason: 'malformed' | 'expired' }

/**
 * Pure verification of an already signature-checked payload: validates the
 * claim shape then rejects expired tokens. `now` is seconds since epoch.
 */
export function verifyClaims(raw: unknown, now: number): ClaimsResult {
    const parsed = deviceTokenClaims.safeParse(raw)
    if (!parsed.success) return { ok: false, reason: 'malformed' }
    if (parsed.data.exp <= now) return { ok: false, reason: 'expired' }
    return { ok: true, claims: parsed.data }
}

/**
 * Port: signs claims into a token string and reverses that to a raw payload.
 * `verifySignature` returns the decoded payload on a valid signature, else null.
 * Implemented by the jose adapter at the edge.
 */
export interface TokenSigner {
    sign(claims: DeviceTokenClaims): Promise<string>
    verifySignature(token: string): Promise<unknown | null>
}

/** Port: token revocation denylist keyed by `jti` (valkey adapter at the edge). */
export interface RevocationStore {
    revoke(jti: string, expiresAtSec: number): Promise<void>
    isRevoked(jti: string): Promise<boolean>
}
