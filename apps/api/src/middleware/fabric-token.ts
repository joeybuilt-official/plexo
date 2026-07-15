// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric device-token signer — jose adapter (Phase 1c).
 *
 * Reuses the same JWT lib as run-jwt.ts (jose, HS256). Implements the domain
 * `TokenSigner` port: sign claims → compact JWT, verify signature → raw payload.
 * The pure exp/shape check lives in `verifyClaims` (domain); revocation lives in
 * the valkey `RevocationStore`.
 */

import { SignJWT, jwtVerify } from 'jose'
import type { DeviceTokenClaims, TokenSigner } from '@plexo/session-fabric'
import { logger } from '../logger.js'

const ISSUER = 'plexo-fabric'

let cachedSecret: Uint8Array | null = null

function getSecret(): Uint8Array {
    if (cachedSecret) return cachedSecret
    const raw = process.env.FABRIC_DEVICE_TOKEN_SECRET ?? process.env.PLEXO_RUN_JWT_SECRET
    if (!raw || raw.length < 32) {
        throw new Error('FABRIC_DEVICE_TOKEN_SECRET must be set to a ≥32-char secret for fabric device tokens')
    }
    cachedSecret = new TextEncoder().encode(raw)
    return cachedSecret
}

/** Default device-token lifetime (seconds); override per-issue. */
export const DEFAULT_DEVICE_TOKEN_TTL_S = 900

export function makeTokenSigner(): TokenSigner {
    return {
        async sign(claims: DeviceTokenClaims): Promise<string> {
            return new SignJWT({
                deviceId: claims.deviceId,
                participantId: claims.participantId,
                workspaceId: claims.workspaceId,
                tier: claims.tier,
                jti: claims.jti,
            })
                .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
                .setIssuedAt(claims.iat)
                .setExpirationTime(claims.exp)
                .setIssuer(ISSUER)
                .setJti(claims.jti)
                .sign(getSecret())
        },
        async verifySignature(token: string): Promise<unknown | null> {
            try {
                const { payload } = await jwtVerify(token, getSecret(), {
                    issuer: ISSUER,
                    algorithms: ['HS256'],
                })
                return {
                    deviceId: payload.deviceId,
                    participantId: payload.participantId,
                    workspaceId: payload.workspaceId,
                    tier: payload.tier,
                    jti: payload.jti,
                    iat: payload.iat,
                    exp: payload.exp,
                }
            } catch (err) {
                logger.warn({ err: (err as Error).message }, 'fabric device-token verify failed')
                return null
            }
        },
    }
}
