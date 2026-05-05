// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeAll } from 'vitest'
import {
    SENSITIVE_CONFIG_KEYS,
    isEncrypted,
    tryEncrypt,
    tryDecrypt,
    encryptSensitiveConfigKeys,
    decryptSensitiveConfigKeys,
} from '../channel-config-crypto.js'

beforeAll(() => {
    process.env.ENCRYPTION_SECRET = 'test-secret-do-not-use-in-prod'
})

const WS = '00000000-0000-0000-0000-000000000001'

describe('SENSITIVE_CONFIG_KEYS map (Phase O)', () => {
    it('twilio sensitive keys', () => {
        expect([...SENSITIVE_CONFIG_KEYS.twilio!].sort()).toEqual(['accountSid', 'authToken'])
    })
    it('telegram aliases token + bot_token', () => {
        expect([...SENSITIVE_CONFIG_KEYS.telegram!].sort()).toEqual(['bot_token', 'token'])
    })
    it('slack covers signingSecret + token + webhook variants', () => {
        const s = [...SENSITIVE_CONFIG_KEYS.slack!].sort()
        expect(s).toContain('signingSecret')
        expect(s).toContain('token')
        expect(s).toContain('webhook')
        expect(s).toContain('webhookUrl')
        expect(s).toContain('webhook_url')
    })
    it('discord webhook variants', () => {
        const s = [...SENSITIVE_CONFIG_KEYS.discord!].sort()
        expect(s).toContain('webhook')
        expect(s).toContain('webhookUrl')
        expect(s).toContain('webhook_url')
    })
    it('gmail/whatsapp/signal/matrix have no sensitive keys (kept for completeness)', () => {
        for (const t of ['gmail', 'whatsapp', 'signal', 'matrix']) {
            expect(SENSITIVE_CONFIG_KEYS[t]!.size).toBe(0)
        }
    })
})

describe('isEncrypted', () => {
    it('true for `enc:` prefix', () => {
        expect(isEncrypted('enc:abc.def.ghi')).toBe(true)
    })
    it('false for plaintext', () => {
        expect(isEncrypted('AC' + 'a'.repeat(32))).toBe(false)
        expect(isEncrypted('')).toBe(false)
    })
    it('false for non-strings', () => {
        expect(isEncrypted(42)).toBe(false)
        expect(isEncrypted(null)).toBe(false)
        expect(isEncrypted(undefined)).toBe(false)
    })
})

describe('tryEncrypt / tryDecrypt — round trip', () => {
    it('encrypts then decrypts to the original plaintext', () => {
        const ct = tryEncrypt('hello-secret', WS) as string
        expect(ct.startsWith('enc:')).toBe(true)
        expect(tryDecrypt(ct, WS, 'twilio')).toBe('hello-secret')
    })
    it('non-strings pass through unchanged', () => {
        expect(tryEncrypt(42, WS)).toBe(42)
        expect(tryEncrypt(null, WS)).toBe(null)
        expect(tryEncrypt(undefined, WS)).toBe(undefined)
        expect(tryEncrypt(true, WS)).toBe(true)
    })
    it('empty string passes through', () => {
        expect(tryEncrypt('', WS)).toBe('')
    })
    it('already-encrypted does not double-encrypt', () => {
        const once = tryEncrypt('secret', WS) as string
        const twice = tryEncrypt(once, WS) as string
        expect(twice).toBe(once)
        expect(tryDecrypt(twice, WS, 'twilio')).toBe('secret')
    })
})

describe('tryDecrypt — legacy plaintext compatibility', () => {
    it('returns plaintext as-is when not enc:-prefixed (legacy row)', () => {
        expect(tryDecrypt('plain-token', WS, 'telegram')).toBe('plain-token')
    })
    it('non-strings pass through', () => {
        expect(tryDecrypt(42, WS, 'twilio')).toBe(42)
    })
})

describe('encryptSensitiveConfigKeys / decryptSensitiveConfigKeys', () => {
    it('twilio: encrypts authToken + accountSid; passes fromNumber through', () => {
        const enc = encryptSensitiveConfigKeys('twilio', {
            authToken: 'sk_secret_xyz',
            accountSid: 'AC' + 'a'.repeat(32),
            fromNumber: '+15551234567',
        }, WS)
        expect(isEncrypted(enc.authToken)).toBe(true)
        expect(isEncrypted(enc.accountSid)).toBe(true)
        expect(enc.fromNumber).toBe('+15551234567')

        const dec = decryptSensitiveConfigKeys('twilio', enc, WS)
        expect(dec.authToken).toBe('sk_secret_xyz')
        expect(dec.accountSid).toBe('AC' + 'a'.repeat(32))
        expect(dec.fromNumber).toBe('+15551234567')
    })

    it('telegram: encrypts both token and bot_token aliases', () => {
        const enc = encryptSensitiveConfigKeys('telegram', { token: 'bot:secret' }, WS)
        expect(isEncrypted(enc.token)).toBe(true)
        const enc2 = encryptSensitiveConfigKeys('telegram', { bot_token: 'bot:other' }, WS)
        expect(isEncrypted(enc2.bot_token)).toBe(true)
    })

    it('gmail: no sensitive keys → returned as-is (no encryption applied)', () => {
        const cfg = { installedConnectionId: 'uuid', emailAddress: 'a@b.com' }
        const enc = encryptSensitiveConfigKeys('gmail', cfg, WS)
        expect(enc.installedConnectionId).toBe('uuid')
        expect(enc.emailAddress).toBe('a@b.com')
    })

    it('mixed: legacy plaintext + new ciphertext on same config (during migration window)', () => {
        const partiallyEncrypted = {
            authToken: 'enc:abc.def.ghi',  // already encrypted (would actually be from real encrypt)
            accountSid: 'AC' + 'a'.repeat(32),  // legacy plaintext
            fromNumber: '+15551234567',
        }
        const enc = encryptSensitiveConfigKeys('twilio', partiallyEncrypted, WS)
        // Already-encrypted stays as-is (no double encrypt)
        expect(enc.authToken).toBe('enc:abc.def.ghi')
        // Plaintext gets encrypted
        expect(isEncrypted(enc.accountSid)).toBe(true)
        // Non-sensitive untouched
        expect(enc.fromNumber).toBe('+15551234567')
    })

    it('unknown channel type defaults to no encryption (no sensitive keys map entry)', () => {
        const cfg = { authToken: 'plaintext-secret' }
        const enc = encryptSensitiveConfigKeys('made_up_type', cfg, WS)
        // Conservative default: no sensitive set → no encryption
        expect(enc.authToken).toBe('plaintext-secret')
    })

    it('different workspaces produce different ciphertext for same plaintext', () => {
        const a = encryptSensitiveConfigKeys('twilio', { authToken: 'same-secret' }, '00000000-0000-0000-0000-000000000001')
        const b = encryptSensitiveConfigKeys('twilio', { authToken: 'same-secret' }, '00000000-0000-0000-0000-000000000002')
        expect(a.authToken).not.toBe(b.authToken)
    })
})
