// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * QA-opt SEC1 / ADR 0039: SSRF egress guard. Covers the literal classifier
 * (isPrivateIp / isSsrfTarget) and the async assert's literal-IP rejection.
 * DNS-resolution behaviour is exercised live post-deploy (network-dependent).
 */
import { describe, it, expect } from 'vitest'
import { isPrivateIp, isSsrfTarget, assertUrlSafe, SsrfBlockedError } from '../ssrf.js'

describe('isPrivateIp', () => {
    it('flags private / loopback / link-local / reserved', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
            expect(isPrivateIp(ip), ip).toBe(true)
        }
    })
    it('allows public addresses', () => {
        for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111']) {
            expect(isPrivateIp(ip), ip).toBe(false)
        }
    })
})

describe('isSsrfTarget', () => {
    it('blocks non-http, localhost, metadata, and private literal IPs', () => {
        for (const u of ['file:///etc/passwd', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal/', 'http://10.0.0.1/', 'not a url']) {
            expect(isSsrfTarget(u), u).toBe(true)
        }
    })
    it('allows public https hosts', () => {
        expect(isSsrfTarget('https://example.com/a')).toBe(false)
        expect(isSsrfTarget('https://8.8.8.8/')).toBe(false)
    })
})

describe('assertUrlSafe', () => {
    it('rejects a literal private IP without touching DNS', async () => {
        await expect(assertUrlSafe('http://127.0.0.1:8080/admin')).rejects.toBeInstanceOf(SsrfBlockedError)
    })
    it('returns the literal IP as the resolved address for an allowed IP host', async () => {
        const r = await assertUrlSafe('https://8.8.8.8/')
        expect(r.addresses).toEqual(['8.8.8.8'])
    })
})
