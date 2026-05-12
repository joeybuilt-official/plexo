// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyTwilioSignature } from '../twilio-signature.js'

const AUTH_TOKEN = 'test-auth-token-12345'

function sign(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
    const sortedKeys = Object.keys(params).sort()
    let data = url
    for (const k of sortedKeys) data += k + params[k]
    return createHmac('sha1', token).update(data).digest('base64')
}

describe('verifyTwilioSignature', () => {
    const url = 'https://api.example.com/api/v1/channels/twilio/events/abc-123'
    const params = {
        From: '+15551234567',
        To: '+15557654321',
        Body: 'hello plexo',
        MessageSid: 'SM' + 'a'.repeat(32),
        AccountSid: 'AC' + 'b'.repeat(32),
    }

    it('accepts a correctly signed request', () => {
        const sig = sign(url, params)
        expect(verifyTwilioSignature(url, params, sig, AUTH_TOKEN)).toBe(true)
    })

    it('rejects a wrong signature', () => {
        const wrong = createHmac('sha1', 'different-token').update(url).digest('base64')
        expect(verifyTwilioSignature(url, params, wrong, AUTH_TOKEN)).toBe(false)
    })

    it('rejects a missing signature', () => {
        expect(verifyTwilioSignature(url, params, '', AUTH_TOKEN)).toBe(false)
    })

    it('rejects a missing auth token', () => {
        const sig = sign(url, params)
        expect(verifyTwilioSignature(url, params, sig, '')).toBe(false)
    })

    it('returns the same verdict regardless of param insertion order', () => {
        const sig = sign(url, params)
        const reordered: Record<string, string> = {}
        for (const k of Object.keys(params).reverse()) reordered[k] = params[k as keyof typeof params]
        expect(verifyTwilioSignature(url, reordered, sig, AUTH_TOKEN)).toBe(true)
    })

    it('rejects a same-length but wrong signature (timing-safe path)', () => {
        const valid = sign(url, params)
        const tampered = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A')
        expect(tampered.length).toBe(valid.length)
        expect(verifyTwilioSignature(url, params, tampered, AUTH_TOKEN)).toBe(false)
    })

    it('preserves query string in the signed URL', () => {
        const urlWithQuery = `${url}?foo=bar&baz=qux`
        const sig = sign(urlWithQuery, params)
        expect(verifyTwilioSignature(urlWithQuery, params, sig, AUTH_TOKEN)).toBe(true)
        expect(verifyTwilioSignature(url, params, sig, AUTH_TOKEN)).toBe(false)
    })
})
