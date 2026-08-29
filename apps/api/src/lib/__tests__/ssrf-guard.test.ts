// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { isSSRFSafeUrl, resolveAndCheckSSRFSafe } from '../ssrf-guard.js'

describe('isSSRFSafeUrl', () => {
    describe('selfhosted / embedded mode', () => {
        it('allows loopback addresses', () => {
            expect(isSSRFSafeUrl('http://localhost:11434', 'selfhosted')).toEqual({ ok: true })
            expect(isSSRFSafeUrl('http://127.0.0.1:11434', 'embedded')).toEqual({ ok: true })
        })
        it('allows private IPv4 ranges', () => {
            expect(isSSRFSafeUrl('http://192.168.1.5:11434', 'selfhosted')).toEqual({ ok: true })
            expect(isSSRFSafeUrl('http://10.0.0.5:11434', 'selfhosted')).toEqual({ ok: true })
        })
        it('allows docker-internal hostnames', () => {
            expect(isSSRFSafeUrl('http://ollama:11434', 'selfhosted')).toEqual({ ok: true })
        })
    })

    describe('cloud mode', () => {
        it('blocks loopback variants', () => {
            for (const u of ['http://localhost', 'http://127.0.0.1', 'http://0.0.0.0']) {
                expect(isSSRFSafeUrl(u, 'cloud').ok).toBe(false)
            }
        })
        it('blocks RFC1918 private IPv4 ranges', () => {
            for (const u of [
                'http://10.0.0.5',
                'http://172.16.0.1',
                'http://172.31.255.255',
                'http://192.168.1.1',
            ]) {
                expect(isSSRFSafeUrl(u, 'cloud').ok).toBe(false)
            }
        })
        it('blocks link-local / cloud metadata', () => {
            expect(isSSRFSafeUrl('http://169.254.169.254/latest/meta-data/', 'cloud').ok).toBe(false)
        })
        it('blocks docker-internal hostnames', () => {
            for (const h of ['postgres', 'redis', 'plexo-db', 'plexo-api', 'ollama', 'plexo-embeddings']) {
                expect(isSSRFSafeUrl(`http://${h}:5432`, 'cloud').ok).toBe(false)
            }
        })
        it('blocks the web dashboard under both its old and new service name', () => {
            // The compose service was renamed plexo-saas -> plexo. The denylist keeps
            // both: a name that still resolves on the network must stay blocked.
            for (const h of ['plexo-saas', 'plexo']) {
                expect(isSSRFSafeUrl(`http://${h}:3000`, 'cloud').ok).toBe(false)
            }
        })
        it('rejects invalid URLs', () => {
            expect(isSSRFSafeUrl('not a url', 'cloud').ok).toBe(false)
            expect(isSSRFSafeUrl('', 'cloud').ok).toBe(false)
        })
        it('rejects non-http(s) protocols', () => {
            expect(isSSRFSafeUrl('file:///etc/passwd', 'cloud').ok).toBe(false)
            expect(isSSRFSafeUrl('ftp://example.com', 'cloud').ok).toBe(false)
            expect(isSSRFSafeUrl('javascript:alert(1)', 'cloud').ok).toBe(false)
        })
        it('allows public URLs', () => {
            expect(isSSRFSafeUrl('https://api.example.com', 'cloud')).toEqual({ ok: true })
            expect(isSSRFSafeUrl('http://ollama.example.com:11434', 'cloud')).toEqual({ ok: true })
        })
        it('returns a human-readable reason for blocked URLs', () => {
            const r = isSSRFSafeUrl('http://192.168.1.5', 'cloud')
            expect(r.ok).toBe(false)
            if (!r.ok) expect(r.reason).toMatch(/private/i)
        })
    })
})

describe('resolveAndCheckSSRFSafe (DNS-rebind protection)', () => {
    it('no-ops on selfhosted / embedded', async () => {
        await expect(resolveAndCheckSSRFSafe('http://anything.example.com', 'selfhosted')).resolves.toEqual({ ok: true })
        await expect(resolveAndCheckSSRFSafe('http://localhost', 'embedded')).resolves.toEqual({ ok: true })
    })

    it('rejects on cloud when sync check already fails', async () => {
        const r = await resolveAndCheckSSRFSafe('http://192.168.1.5', 'cloud')
        expect(r.ok).toBe(false)
    })

    it('skips DNS lookup for IP-literal hosts (already handled by sync check)', async () => {
        const r = await resolveAndCheckSSRFSafe('http://203.0.113.5', 'cloud')
        expect(r.ok).toBe(true)
    })

    it('rejects when DNS resolves to a private IP (rebind defense)', async () => {
        const lookup = async () => [{ address: '10.0.0.1', family: 4 }]
        const r = await resolveAndCheckSSRFSafe('http://attacker.example.com', 'cloud', lookup)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toMatch(/10\.0\.0\.1/)
    })

    it('rejects when DNS resolves to loopback IPv6', async () => {
        const lookup = async () => [{ address: '::1', family: 6 }]
        const r = await resolveAndCheckSSRFSafe('http://attacker.example.com', 'cloud', lookup)
        expect(r.ok).toBe(false)
    })

    it('accepts when all DNS records are public', async () => {
        const lookup = async () => [
            { address: '203.0.113.5', family: 4 },
            { address: '2606:4700::1', family: 6 },
        ]
        const r = await resolveAndCheckSSRFSafe('http://api.example.com', 'cloud', lookup)
        expect(r.ok).toBe(true)
    })

    it('rejects on DNS resolution failure (NXDOMAIN, timeout, etc.)', async () => {
        const lookup = async () => { throw new Error('ENOTFOUND') }
        const r = await resolveAndCheckSSRFSafe('http://nope.example.invalid', 'cloud', lookup)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toMatch(/DNS lookup failed/)
    })

    it('rejects when even one of multiple records points to a private IP', async () => {
        const lookup = async () => [
            { address: '203.0.113.5', family: 4 },
            { address: '10.0.0.1', family: 4 },
        ]
        const r = await resolveAndCheckSSRFSafe('http://api.example.com', 'cloud', lookup)
        expect(r.ok).toBe(false)
    })

    it('rejects when DNS returns no records (NODATA)', async () => {
        const lookup = async () => []
        const r = await resolveAndCheckSSRFSafe('http://nodata.example.com', 'cloud', lookup)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toMatch(/no records/)
    })
})
