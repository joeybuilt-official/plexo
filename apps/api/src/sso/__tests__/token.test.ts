// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SSO token unit tests.
 *
 * Pins:
 *   1. mintToken throws on weak secret
 *   2. verifyToken returns ok=false for malformed strings
 *   3. verifyToken returns bad_signature when HMAC tampered
 *   4. verifyToken returns expired when exp elapsed
 *   5. verifyToken returns app_mismatch when slug differs
 *   6. verifyToken returns ok with payload on valid+fresh
 *   7. markUsedOnce is true on first call, false on second (single-use)
 */

import { describe, it, expect } from 'vitest'
import {
    mintToken,
    verifyToken,
    markUsedOnce,
    isUsed,
    TOKEN_TTL_SECONDS,
} from '../token.js'

const SECRET = 'a'.repeat(64) // 64-char hex equivalent length
const USER_ID = '11111111-2222-3333-4444-555555555555'

describe('sso/token — mintToken', () => {
    it('throws on a too-short secret', () => {
        expect(() => mintToken('short', { userId: USER_ID, appSlug: 'koforje' }))
            .toThrow(/SSO_HANDOFF_SECRET/)
    })

    it('produces a payload + token with the expected shape', () => {
        const { token, payload } = mintToken(SECRET, { userId: USER_ID, appSlug: 'koforje' })
        expect(token.split('.')).toHaveLength(2)
        expect(payload.userId).toBe(USER_ID)
        expect(payload.appSlug).toBe('koforje')
        expect(payload.exp - payload.iat).toBe(TOKEN_TTL_SECONDS)
        expect(payload.jti).toMatch(/^[0-9a-f]{32}$/)
    })
})

describe('sso/token — verifyToken', () => {
    it('rejects malformed input', () => {
        expect(verifyToken(SECRET, '', 'koforje')).toEqual({ ok: false, reason: 'malformed' })
        expect(verifyToken(SECRET, 'no-dot-anywhere', 'koforje')).toEqual({ ok: false, reason: 'malformed' })
        expect(verifyToken(SECRET, '.', 'koforje')).toEqual({ ok: false, reason: 'malformed' })
    })

    it('rejects a tampered HMAC', () => {
        const { token } = mintToken(SECRET, { userId: USER_ID, appSlug: 'koforje' })
        // Flip the FIRST character of the signature segment, not the last.
        // The signature is 32 bytes encoded as 43 base64url chars; the final
        // char only contributes 2 bits to the decoded output, so flipping it
        // sometimes yields a different b64url string that decodes to the
        // same 32 bytes (the differing bits land in unused padding). The
        // first signature char always covers 6 meaningful bits.
        const dot = token.indexOf('.')
        expect(dot).toBeGreaterThan(0)
        const sigStart = dot + 1
        const ch = token[sigStart]
        const newCh = ch === 'a' ? 'b' : 'a'
        const flipped = token.slice(0, sigStart) + newCh + token.slice(sigStart + 1)
        const result = verifyToken(SECRET, flipped, 'koforje')
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toBe('bad_signature')
    })

    it('rejects a token signed with a different secret', () => {
        const { token } = mintToken(SECRET, { userId: USER_ID, appSlug: 'koforje' })
        const result = verifyToken('b'.repeat(64), token, 'koforje')
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toBe('bad_signature')
    })

    it('rejects an expired token', () => {
        const { token } = mintToken(SECRET, { userId: USER_ID, appSlug: 'koforje', ttlSeconds: -10 })
        const result = verifyToken(SECRET, token, 'koforje')
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toBe('expired')
    })

    it('rejects an app slug mismatch', () => {
        const { token } = mintToken(SECRET, { userId: USER_ID, appSlug: 'koforje' })
        const result = verifyToken(SECRET, token, 'levio')
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toBe('app_mismatch')
    })

    it('accepts a valid + fresh token', () => {
        const { token, payload } = mintToken(SECRET, { userId: USER_ID, appSlug: 'koforje' })
        const result = verifyToken(SECRET, token, 'koforje')
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.payload.userId).toBe(USER_ID)
            expect(result.payload.jti).toBe(payload.jti)
        }
    })
})

// ── Single-use enforcement (markUsedOnce) ───────────────────────────────
// We mock a tiny in-memory Redis surface that mirrors SET NX EX semantics.

function makeFakeRedis(): {
    set: (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => Promise<'OK' | null>
    get: (k: string) => Promise<string | null>
} {
    const store = new Map<string, string>()
    return {
        async set(key, value, opts) {
            if (opts?.NX && store.has(key)) return null
            store.set(key, value)
            return 'OK'
        },
        async get(key) {
            return store.get(key) ?? null
        },
    }
}

describe('sso/token — single-use enforcement', () => {
    it('returns true on first mark, false on replay', async () => {
        const redis = makeFakeRedis() as unknown as Parameters<typeof markUsedOnce>[0]
        const jti = 'deadbeefdeadbeefdeadbeefdeadbeef'
        expect(await markUsedOnce(redis, jti)).toBe(true)
        expect(await markUsedOnce(redis, jti)).toBe(false)
        expect(await isUsed(redis, jti)).toBe(true)
    })
})
