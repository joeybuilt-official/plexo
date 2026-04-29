// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SSO config — feature flag, allow-list, and return-URL host validation.
 *
 * The allow-list is intentionally hard-coded. Adding a new sibling app to
 * SSO is a one-way trust decision that should require an explicit code
 * change + review, not an env-var flip.
 */

/** Slugs and the hostnames their `return` URL is allowed to point at.
 *  A value array means "any of these hosts is acceptable". */
export const SSO_ALLOWED_APPS: Record<string, readonly string[]> = {
    koforje: ['koforje.com', 'www.koforje.com', 'app.koforje.com'],
    nexalog: ['nexalog.com', 'www.nexalog.com', 'app.nexalog.com'],
    fonto: ['fonto.app', 'www.fonto.app', 'app.fonto.app'],
    levio: ['levio.app', 'www.levio.app', 'app.levio.app'],
    fylo: ['fylo.app', 'www.fylo.app', 'app.fylo.app'],
    frameforge: ['frameforge.ai', 'www.frameforge.ai', 'app.frameforge.ai'],
}

export function isAllowedAppSlug(slug: string): slug is keyof typeof SSO_ALLOWED_APPS {
    return Object.prototype.hasOwnProperty.call(SSO_ALLOWED_APPS, slug)
}

/** Validate a `return` URL: must be https, must have a host on the
 *  allow-list for the requested app slug. Returns null if invalid. */
export function validateReturnUrl(slug: string, raw: string): URL | null {
    if (!isAllowedAppSlug(slug)) return null
    let u: URL
    try {
        u = new URL(raw)
    } catch {
        return null
    }
    // Only https in production. Allow http for localhost/dev so the same
    // code path can be exercised end-to-end without TLS plumbing.
    const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalhost)) return null
    const allowed = SSO_ALLOWED_APPS[slug]
    if (!allowed) return null
    if (!allowed.includes(u.hostname) && !isLocalhost) return null
    return u
}

export function isSsoEnabled(): boolean {
    return process.env.PLEXO_SSO_ENABLED === 'true'
}

export function getSsoSecret(): string | null {
    const s = process.env.SSO_HANDOFF_SECRET
    if (!s || s.length < 32) return null
    return s
}
