// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Route inventory for the visual-regression + a11y matrix (QA-opt FE7/FE8,
 * ADR 0040). `auth: false` routes render without a session; `auth: true` routes
 * are skipped by the specs when no session is present (auth.setup produced an
 * empty state). Keep this list as the single source of truth for both specs.
 */
export interface RouteDef {
    /** URL path to visit. */
    path: string
    /** Stable snapshot id (filename-safe). */
    id: string
    /** Requires an authenticated session. */
    auth: boolean
}

export const ROUTES: RouteDef[] = [
    // Public surfaces
    { path: '/login', id: 'login', auth: false },
    { path: '/register', id: 'register', auth: false },
    { path: '/signup', id: 'signup', auth: false },
    { path: '/forgot-password', id: 'forgot-password', auth: false },
    { path: '/privacy', id: 'privacy', auth: false },
    { path: '/terms', id: 'terms', auth: false },
    // Authed landings (the high-traffic nav surfaces)
    { path: '/app/home', id: 'home', auth: true },
    { path: '/app/chat', id: 'chat', auth: true },
    { path: '/app/tasks', id: 'tasks', auth: true },
    { path: '/app/agents/live', id: 'agents-live', auth: true },
    { path: '/app/approvals', id: 'approvals', auth: true },
    { path: '/app/memory', id: 'memory', auth: true },
    { path: '/app/connections', id: 'connections', auth: true },
    { path: '/app/conversations', id: 'conversations', auth: true },
    { path: '/app/settings/intelligence/routing', id: 'settings-routing', auth: true },
    { path: '/app/projects', id: 'projects', auth: true },
    { path: '/app/account', id: 'account', auth: true },
    { path: '/app/scheduling', id: 'scheduling', auth: true },
    { path: '/app/outcomes', id: 'outcomes', auth: true },
    { path: '/app/works', id: 'works', auth: true },
    { path: '/app/revisions', id: 'revisions', auth: true },
    { path: '/app/logs', id: 'logs', auth: true },
    { path: '/app/settings/intelligence/providers', id: 'settings-providers', auth: true },
]

/**
 * Selectors for non-deterministic regions masked out of visual baselines:
 * the cookie notice (auto-dismisses on interaction), the live agent stream,
 * and the provider-balance alert banners. Relative timestamps that aren't in
 * these containers are absorbed by maxDiffPixelRatio.
 */
export const VISUAL_MASK_SELECTORS = [
    '[data-testid="cookie-consent"]',
    '[role="log"]',
    '[role="alert"]',
]
