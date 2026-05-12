// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Better Auth — shared service instance
 *
 * Replaces the previous Supabase Auth setup.  All Joeybuilt apps point at
 * the same `auth` schema inside the shared Postgres database, giving every
 * service a single user-identity source of truth.
 *
 * AUTH_DATABASE_URL  – connection string for the shared DB (contains `auth` schema)
 * AUTH_SECRET        – HMAC secret for session signing (must match plexo-ops)
 */

import { type Auth } from 'better-auth'
import { Pool } from 'pg'
import { createPlexoBetterAuth } from '@plexo/db/auth/config'

// DI-002: Internal API base + service key for the beforeDelete hook.
// These are server-side only (never shipped to the browser).
const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? ''

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _auth: any = null

export function getAuth(): Auth {
    if (_auth) return _auth as Auth

    const pool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL })
    pool.on('connect', (client: { query: (sql: string) => Promise<unknown> }) => {
        client.query('SET search_path TO auth').catch((err: unknown) => {
            console.error('[better-auth] Failed to set search_path to auth:', err)
        })
    })

    // Cross-app SSO: in production, set BETTER_AUTH_COOKIE_DOMAIN=.your-shared-domain.com
    // so a login on one app carries to sibling apps on the same domain.
    // In dev we omit the attribute entirely (localhost) to avoid cookie rejection.
    const cookieDomain = process.env.BETTER_AUTH_COOKIE_DOMAIN?.trim()
    const baseURL = process.env.BETTER_AUTH_URL?.trim()
    const trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

    // Google OAuth for login — uses the same credentials as workspace connections.
    // Only openid + profile + email scopes for login (no Gmail/Calendar/Drive).
    const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim()
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()

    _auth = createPlexoBetterAuth({
        pool,
        secret: process.env.AUTH_SECRET!,
        baseURL,
        trustedOrigins,
        cookieDomain,
        secureCookies: process.env.NODE_ENV === 'production',
        google:
            googleClientId && googleClientSecret
                ? { clientId: googleClientId, clientSecret: googleClientSecret }
                : undefined,
        sendResetPassword: async ({ user, url }) => {
            // Email delivery is wired via the same mailer used by Command Center.
            // Until a production mailer is configured, log the URL so local
            // dev can follow the reset link without an SMTP server.
            console.info('[better-auth] reset password link', { email: user.email, url })
        },
        sendVerificationEmail: async ({ user, url }) => {
            console.info('[better-auth] verification email', { email: user.email, url })
        },
        onBeforeUserDelete: async (user) => {
            if (!SERVICE_KEY) {
                console.warn('[better-auth] PLEXO_SERVICE_KEY not set — skipping workspace cleanup')
                return
            }
            try {
                const res = await fetch(`${INTERNAL_API_URL}/api/v1/auth/account-cleanup`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SERVICE_KEY}`,
                        'X-App-Id': 'plexo-web',
                    },
                    body: JSON.stringify({ userId: user.id }),
                })
                if (!res.ok) {
                    const body = await res.text()
                    console.error('[better-auth] Workspace cleanup failed:', res.status, body)
                }
            } catch (err) {
                console.error('[better-auth] Workspace cleanup request failed:', err)
            }
        },
    })

    return _auth as Auth
}
