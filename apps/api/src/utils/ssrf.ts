// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/** Raised by assertUrlSafe / safeFetch when a target resolves to a blocked address. */
export class SsrfBlockedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SsrfBlockedError'
    }
}

/** True when a literal IP string is private / loopback / link-local / reserved. */
export function isPrivateIp(ip: string): boolean {
    const host = ip.replace(/^\[|\]$/g, '').toLowerCase()
    const v = isIP(host)
    if (v === 4) {
        const parts = host.split('.').map(Number)
        const a = parts[0] ?? 0, b = parts[1] ?? 0
        if (a === 127) return true            // loopback
        if (a === 10) return true             // private
        if (a === 172 && b >= 16 && b <= 31) return true // private
        if (a === 192 && b === 168) return true // private
        if (a === 169 && b === 254) return true // link-local (incl. cloud metadata)
        if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
        if (a === 0) return true              // "this" network
        return false
    }
    if (v === 6) {
        if (host === '::1') return true       // loopback
        if (host === '::') return true
        if (/^f[cd]/i.test(host)) return true // unique-local fc00::/7
        if (/^fe[89ab]/i.test(host)) return true // link-local fe80::/10
        // IPv4-mapped (::ffff:a.b.c.d) — extract and re-check
        const m = /::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)
        if (m && m[1]) return isPrivateIp(m[1])
        return false
    }
    return false
}

// Returns true when the URL targets a private/internal network address by its
// LITERAL hostname (synchronous, no DNS). Kept for fast pre-checks; assertUrlSafe
// adds the DNS-resolution step that closes the rebinding / CNAME-to-internal gap.
export function isSsrfTarget(rawUrl: string): boolean {
    let parsed: URL
    try {
        parsed = new URL(rawUrl)
    } catch {
        return true
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return true

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()

    const blockedHostnames = [
        'localhost',
        'metadata.google.internal',
        'metadata.aws.internal',
        '169.254.169.254',
    ]
    if (blockedHostnames.includes(hostname)) return true

    if (isIP(hostname)) return isPrivateIp(hostname)
    return false
}

/**
 * Async SSRF guard: literal checks PLUS DNS resolution — rejects when ANY
 * resolved A/AAAA record is private/reserved. Closes the gap where a public
 * hostname (or a DNS-rebinding host) resolves to an internal IP. Returns the
 * resolved addresses so a caller may pin the connection to a vetted IP.
 * Throws SsrfBlockedError on any violation.
 */
export async function assertUrlSafe(rawUrl: string): Promise<{ host: string; addresses: string[] }> {
    if (isSsrfTarget(rawUrl)) {
        throw new SsrfBlockedError('URL targets a restricted or private address')
    }
    const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '')
    if (isIP(host)) return { host, addresses: [host] } // already validated literal
    let resolved: { address: string }[]
    try {
        resolved = await lookup(host, { all: true })
    } catch {
        throw new SsrfBlockedError(`Could not resolve host: ${host}`)
    }
    const addresses = resolved.map(r => r.address)
    for (const addr of addresses) {
        if (isPrivateIp(addr)) {
            throw new SsrfBlockedError(`Host ${host} resolves to a private address`)
        }
    }
    return { host, addresses }
}

/**
 * SSRF-safe fetch: validates the target (incl. DNS) before connecting, disables
 * automatic redirects, and re-validates every redirect hop's Location against
 * the same guard. Use for any fetch whose URL is user-influenced.
 */
export async function safeFetch(
    rawUrl: string,
    init: RequestInit = {},
    opts: { maxRedirects?: number } = {},
): Promise<Response> {
    const maxRedirects = opts.maxRedirects ?? 3
    let url = rawUrl
    for (let hop = 0; hop <= maxRedirects; hop++) {
        await assertUrlSafe(url)
        const res = await fetch(url, { ...init, redirect: 'manual' })
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location')
            if (!loc) return res
            url = new URL(loc, url).toString() // resolve relative redirects, re-validated next loop
            continue
        }
        return res
    }
    throw new SsrfBlockedError('Too many redirects')
}
