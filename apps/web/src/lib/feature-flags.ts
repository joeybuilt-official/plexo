// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Server-side feature flags for the Plexo dashboard (apps/web).
 *
 * Flags default to the safest "self-hostable" setting — a fresh
 * `docker compose up` should land users on `/login`, not the
 * getplexo.com marketing chrome.
 *
 * Operators of the managed cloud (getplexo.com) opt INTO marketing
 * chrome by setting `PLEXO_MARKETING_ENABLED=true` in their env.
 */

/** True when the env var is set to a truthy value ("1", "true", "yes"). */
function envBool(value: string | undefined): boolean {
    if (!value) return false
    const v = value.trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * Is the public marketing site enabled for this instance?
 *
 * - `true`  → render the getplexo.com landing page at `/`, expose any
 *             marketing-only routes that exist now or land later.
 * - `false` → redirect `/` to `/login` (or `/app` for authed users) and
 *             404 every marketing-only route. Compliance routes
 *             (`/privacy`, `/terms`) stay reachable regardless.
 *
 * Default: `false`. The cloud deployment opts in via env.
 *
 * Legacy: `SKIP_LANDING=true` continues to work as a "marketing off"
 * override so existing self-host setups don't regress.
 */
export function isMarketingEnabled(): boolean {
    if (envBool(process.env.SKIP_LANDING)) return false
    return envBool(process.env.PLEXO_MARKETING_ENABLED)
}

// ── Deployment mode ──────────────────────────────────────────────────────────

export type DeploymentMode = 'cloud' | 'selfhosted' | 'embedded'

/**
 * Resolve the active deployment mode from env. Drives the C2 audience-split:
 * BYOK surfaces (selfhosted, embedded, Cloud-advanced) see model-compat
 * warnings; managed-default Cloud users never do.
 *
 * Reads `NEXT_PUBLIC_PLEXO_DEPLOYMENT_MODE` so it works on both server and
 * client. Falls back to `PLEXO_DEPLOYMENT_MODE` for server-only callers.
 * Defaults to `selfhosted` (the safest assumption — show BYOK UX).
 */
export function getDeploymentMode(): DeploymentMode {
    const raw = (
        process.env.NEXT_PUBLIC_PLEXO_DEPLOYMENT_MODE
        ?? process.env.PLEXO_DEPLOYMENT_MODE
        ?? ''
    ).trim().toLowerCase()
    if (raw === 'cloud') return 'cloud'
    if (raw === 'embedded') return 'embedded'
    return 'selfhosted'
}

/**
 * BYOK UX is shown when the active path is BYOK. That's always true on
 * selfhosted + embedded; on Cloud it's true only when the workspace has at
 * least one user-configured (non-managed) provider — that's the "Cloud
 * advanced" path. The caller passes `hasUserProvider` so this stays a pure
 * function we can test cheaply.
 */
export function shouldShowBYOKModelCompat(
    mode: DeploymentMode,
    hasUserProvider: boolean,
): boolean {
    if (mode === 'selfhosted' || mode === 'embedded') return true
    return hasUserProvider
}
