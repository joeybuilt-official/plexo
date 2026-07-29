// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SSO handoff token primitives.
 *
 * Format: base64url(payloadJson) + "." + base64url(hmacSha256)
 * Payload: { userId, appSlug, iat, exp }
 *
 * - HMAC verified with crypto.timingSafeEqual (constant time).
 * - 60-second expiry from issuance.
 * - Single-use enforcement is layered on top via Redis/Valkey (see
 *   markUsed/isUsed in this module).
 *
 * Tokens are intentionally NOT JWTs. We don't need general claims, alg
 * negotiation, or third-party verifier compatibility — siblings call our
 * /api/sso/verify endpoint instead. A simple HMAC envelope is smaller,
 * faster, and avoids the alg-confusion footguns JWTs have historically
 * shipped with.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import type { RedisClientType } from 'redis'

export interface SsoTokenPayload {
    userId: string
    appSlug: string
    /** issued-at, unix seconds */
    iat: number
    /** expiry, unix seconds */
    exp: number
    /** random nonce — keys the single-use Redis entry */
    jti: string
}

export const TOKEN_TTL_SECONDS = 60
/** Redis TTL for the used-set entry. Longer than token expiry so a replay
 *  attempted right at the boundary still hits the used flag. */
export const USED_KEY_TTL_SECONDS = 300

const USED_KEY_PREFIX = 'sso:used:'

function b64urlEncode(buf: Buffer): string {
    return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function b64urlDecode(s: string): Buffer {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/** Mint a signed handoff token. */
export function mintToken(
    secret: string,
    args: { userId: string; appSlug: string; ttlSeconds?: number },
): { token: string; payload: SsoTokenPayload } {
    if (!secret || secret.length < 32) {
        throw new Error('SSO_HANDOFF_SECRET must be at least 32 chars (use openssl rand -hex 32)')
    }
    const now = Math.floor(Date.now() / 1000)
    const payload: SsoTokenPayload = {
        userId: args.userId,
        appSlug: args.appSlug,
        iat: now,
        exp: now + (args.ttlSeconds ?? TOKEN_TTL_SECONDS),
        jti: randomBytes(16).toString('hex'),
    }
    const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload)))
    const sig = createHmac('sha256', secret).update(payloadB64).digest()
    const token = `${payloadB64}.${b64urlEncode(sig)}`
    return { token, payload }
}

export type VerifyOk = { ok: true; payload: SsoTokenPayload }
export type VerifyErr = { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'app_mismatch' }

/** Verify an HMAC token. Does NOT check the single-use Redis flag —
 *  caller must do that AFTER signature verification, then mark used. */
export function verifyToken(
    secret: string,
    token: string,
    expectedAppSlug: string,
): VerifyOk | VerifyErr {
    if (typeof token !== 'string' || token.length < 10 || token.length > 2048) {
        return { ok: false, reason: 'malformed' }
    }
    const dot = token.indexOf('.')
    if (dot <= 0 || dot === token.length - 1) {
        return { ok: false, reason: 'malformed' }
    }
    const payloadB64 = token.slice(0, dot)
    const sigB64 = token.slice(dot + 1)

    let providedSig: Buffer
    try {
        providedSig = b64urlDecode(sigB64)
    } catch {
        return { ok: false, reason: 'malformed' }
    }
    const expectedSig = createHmac('sha256', secret).update(payloadB64).digest()
    if (providedSig.length !== expectedSig.length) {
        return { ok: false, reason: 'bad_signature' }
    }
    if (!timingSafeEqual(providedSig, expectedSig)) {
        return { ok: false, reason: 'bad_signature' }
    }

    let payload: SsoTokenPayload
    try {
        const parsed = JSON.parse(b64urlDecode(payloadB64).toString('utf8'))
        if (
            !parsed
            || typeof parsed !== 'object'
            || typeof parsed.userId !== 'string'
            || typeof parsed.appSlug !== 'string'
            || typeof parsed.iat !== 'number'
            || typeof parsed.exp !== 'number'
            || typeof parsed.jti !== 'string'
        ) {
            return { ok: false, reason: 'malformed' }
        }
        payload = parsed as SsoTokenPayload
    } catch {
        return { ok: false, reason: 'malformed' }
    }

    const now = Math.floor(Date.now() / 1000)
    if (payload.exp <= now) {
        return { ok: false, reason: 'expired' }
    }
    if (payload.appSlug !== expectedAppSlug) {
        return { ok: false, reason: 'app_mismatch' }
    }
    return { ok: true, payload }
}

/** Atomically mark a token's jti as used. Returns true if the caller is
 *  the first to mark it (i.e. token may be consumed); false if it was
 *  already used. Implemented via SET NX with TTL. */
export async function markUsedOnce(redis: RedisClientType, jti: string): Promise<boolean> {
    const key = USED_KEY_PREFIX + jti
    const result = await redis.set(key, '1', { NX: true, EX: USED_KEY_TTL_SECONDS })
    return result === 'OK'
}

/** Check whether a jti has already been consumed. Mainly for tests/
 *  observability — production callers should use markUsedOnce which is
 *  atomic. */
export async function isUsed(redis: RedisClientType, jti: string): Promise<boolean> {
    const key = USED_KEY_PREFIX + jti
    const v = await redis.get(key)
    return v !== null
}
