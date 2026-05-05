// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { isSSRFSafeUrl } from '../ssrf-guard.js'

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
