// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { isIP } from 'node:net'

// Returns true when the URL targets a private/internal network address.
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

    const v = isIP(hostname)
    if (v === 4) {
        const parts = hostname.split('.').map(Number)
        const a = parts[0], b = parts[1] ?? 0
        if (a === 127) return true
        if (a === 10) return true
        if (a === 172 && b >= 16 && b <= 31) return true
        if (a === 192 && b === 168) return true
        if (a === 169 && b === 254) return true
        if (a === 0) return true
    }
    if (v === 6) {
        if (hostname === '::1') return true
        if (/^f[cd]/i.test(hostname)) return true
        if (/^fe[89ab]/i.test(hostname)) return true
    }
    return false
}
