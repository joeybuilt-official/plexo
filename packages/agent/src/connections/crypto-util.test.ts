// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach } from 'vitest'
import { encrypt, decrypt } from './crypto-util.js'

const WS_ID = 'test-workspace-id'

beforeEach(() => {
    process.env.ENCRYPTION_SECRET = 'test-secret-for-unit-tests-only'
})

describe('crypto-util', () => {
    it('round-trips plaintext', () => {
        const plain = JSON.stringify({ api_key: 'sk-test-1234', org: 'acme' })
        expect(decrypt(encrypt(plain, WS_ID), WS_ID)).toBe(plain)
    })

    it('decrypt handles enc: prefix (API-stored credentials)', () => {
        // Simulate what apps/api/src/crypto.ts stores: "enc:iv.ciphertext.tag"
        // crypto-util.encrypt already adds enc: prefix; decrypt must strip it.
        const plain = JSON.stringify({ token: 'ghp_test' })
        const token = encrypt(plain, WS_ID)
        expect(token.startsWith('enc:')).toBe(true)
        expect(decrypt(token, WS_ID)).toBe(plain)
    })

    it('decrypt accepts legacy tokens without enc: prefix', () => {
        // Build a valid token without the prefix to simulate hypothetical legacy data.
        const plain = 'legacy-value'
        const token = encrypt(plain, WS_ID).slice(4) // strip enc:
        expect(decrypt(token, WS_ID)).toBe(plain)
    })

    it('throws on tampered ciphertext', () => {
        const token = encrypt('secret', WS_ID)
        const parts = token.slice(4).split('.')
        parts[1] = 'AAAA' + (parts[1] ?? '')
        expect(() => decrypt('enc:' + parts.join('.'), WS_ID)).toThrow()
    })

    it('throws on invalid token format', () => {
        expect(() => decrypt('notvalid', WS_ID)).toThrow('Invalid encrypted token format')
    })
})
