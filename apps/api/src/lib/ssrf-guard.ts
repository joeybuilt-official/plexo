// SPDX-License-Identifier: AGPL-3.0-only
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
 * Hostname-only check; DNS-rebind protection is a follow-up.
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
