// SPDX-License-Identifier: AGPL-3.0-only
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
