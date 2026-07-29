// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SSRF guard for user-supplied provider endpoint URLs (e.g., BYOK Ollama).
 *
 * Cloud (multi-tenant): block loopback / private / link-local hosts and
 * known docker-internal service names so a workspace owner can't probe
 * Plexo's own infra by pointing an "Ollama" provider at it.
 *
 * Selfhosted/embedded: allow all — operator controls the network and may
 * legitimately use http://localhost:11434 or http://192.168.x.x.
 *
 * Two layers:
 *   - `isSSRFSafeUrl` — synchronous hostname/IP-literal check. Use for
 *     fast-fail on PATCH/POST request validation.
 *   - `resolveAndCheckSSRFSafe` — async DNS resolution + per-record check.
 *     Catches the case where a public-looking hostname resolves to a
 *     private IP. Run after the sync check on any URL that will later be
 *     fetched server-side.
 *
 * Apply-time DNS-rebind defense (re-resolve at HTTP-request time and
 * verify the resolved IP matches the validated IP) requires injection
 * into the HTTP layer used by each provider adapter — separate phase.
 * `resolveAndCheckSSRFSafe` closes the typical exploit path (validate-time
 * DNS lookup) but cannot defend against an attacker who flips DNS in the
 * window between validation and use.
 */

export type DeploymentMode = 'cloud' | 'selfhosted' | 'embedded'

export function getServerDeploymentMode(): DeploymentMode {
    const raw = (process.env.PLEXO_DEPLOYMENT_MODE ?? '').trim().toLowerCase()
    if (raw === 'cloud') return 'cloud'
    if (raw === 'embedded') return 'embedded'
    return 'selfhosted'
}

const PRIVATE_HOSTS = new Set([
    'localhost', '127.0.0.1', '::1', '0.0.0.0',
    'postgres', 'plexo-db', 'redis', 'valkey', 'plexo-redis',
    'ollama', 'plexo-embeddings', 'plexo-api', 'plexo-web',
    'plexo-saas', 'plexo-hub',
])

const PRIVATE_IPV4 = [
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^169\.254\./,
    /^127\./,
    /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // CGNAT 100.64.0.1/10 (Tailscale addresses)
]

export type SSRFCheck = { ok: true } | { ok: false; reason: string }

export function isSSRFSafeUrl(url: string, mode: DeploymentMode = getServerDeploymentMode()): SSRFCheck {
    if (mode !== 'cloud') return { ok: true }
    let parsed: URL
    try { parsed = new URL(url) } catch { return { ok: false, reason: 'invalid URL' } }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: 'protocol must be http or https' }
    }
    const host = parsed.hostname.toLowerCase()
    if (PRIVATE_HOSTS.has(host)) {
        return { ok: false, reason: `host '${host}' is not allowed on Plexo Cloud` }
    }
    if (PRIVATE_IPV4.some(re => re.test(host))) {
        return { ok: false, reason: 'private IP addresses are not allowed on Plexo Cloud' }
    }
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
        return { ok: false, reason: 'private IPv6 addresses are not allowed on Plexo Cloud' }
    }
    return { ok: true }
}

const PRIVATE_IPV6_PREFIXES = ['fc', 'fd', 'fe80', '::1', '::ffff:127.', '::ffff:10.', '::ffff:192.168.', '::ffff:169.254.']

function ipIsPrivate(ip: string): boolean {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true
    if (PRIVATE_IPV4.some(re => re.test(lower))) return true
    if (PRIVATE_IPV6_PREFIXES.some(p => lower.startsWith(p))) return true
    return false
}

export type DnsLookupFn = (host: string) => Promise<{ address: string; family: number }[]>

/**
 * DNS-resolves `url` and returns `{ ok: false }` if any A/AAAA record points
 * to a private/loopback/link-local address (Cloud only). Catches DNS-rebind
 * attempts where a public hostname resolves to a private IP.
 *
 * No-op on selfhosted/embedded — operator network is trusted.
 *
 * `lookup` is injectable for testability — production calls pass the default.
 */
export async function resolveAndCheckSSRFSafe(
    url: string,
    mode: DeploymentMode = getServerDeploymentMode(),
    lookup?: DnsLookupFn,
): Promise<SSRFCheck> {
    if (mode !== 'cloud') return { ok: true }
    const sync = isSSRFSafeUrl(url, mode)
    if (!sync.ok) return sync

    let parsed: URL
    try { parsed = new URL(url) } catch { return { ok: false, reason: 'invalid URL' } }
    const host = parsed.hostname.toLowerCase()

    // IP-literal hosts already covered by isSSRFSafeUrl — skip DNS work.
    if (/^[0-9.]+$/.test(host) || host.includes(':')) return { ok: true }

    let records: { address: string; family: number }[]
    try {
        if (lookup) {
            records = await lookup(host)
        } else {
            const dns = await import('node:dns/promises')
            records = await dns.lookup(host, { all: true, verbatim: true })
        }
    } catch (err) {
        return { ok: false, reason: `DNS lookup failed for '${host}': ${(err as Error).message}` }
    }
    if (records.length === 0) {
        return { ok: false, reason: `DNS returned no records for '${host}'` }
    }
    for (const r of records) {
        if (ipIsPrivate(r.address)) {
            return { ok: false, reason: `DNS for '${host}' resolves to private address ${r.address}` }
        }
    }
    return { ok: true }
}