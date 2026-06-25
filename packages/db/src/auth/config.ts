// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { betterAuth, type Auth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { db } from '../client'
import { mirrorAuthUserToPublic, type AuthUserPayload } from './mirror'

export { mirrorAuthUserToPublic, type AuthUserPayload } from './mirror'

export interface PlexoAuthOptions {
    pool: Pool
    secret: string
    baseURL?: string
    trustedOrigins?: string[]
    cookieDomain?: string
    secureCookies: boolean
    google?: { clientId: string; clientSecret: string }
    onBeforeUserDelete?: (user: { id: string }) => Promise<void> | void
    sendResetPassword?: (args: { user: { email: string; name?: string }; url: string }) => Promise<void>
    sendVerificationEmail?: (args: { user: { email: string; name?: string }; url: string }) => Promise<void>
}

export function createPlexoBetterAuth(opts: PlexoAuthOptions): Auth {
    const {
        pool,
        secret,
        baseURL,
        trustedOrigins,
        cookieDomain,
        secureCookies,
        google,
        onBeforeUserDelete,
        sendResetPassword,
        sendVerificationEmail,
    } = opts

    const wrappedSendResetPassword = sendResetPassword
        ? async (data: { user: { email: string; name?: string }; url: string }): Promise<void> => {
            await sendResetPassword({ user: { email: data.user.email, name: data.user.name }, url: data.url })
        }
        : undefined
    const wrappedSendVerificationEmail = sendVerificationEmail
        ? async (data: { user: { email: string; name?: string }; url: string }): Promise<void> => {
            await sendVerificationEmail({ user: { email: data.user.email, name: data.user.name }, url: data.url })
        }
        : undefined
    const wrappedBeforeDelete = onBeforeUserDelete
        ? async (user: { id: string }): Promise<void> => {
            await onBeforeUserDelete(user)
        }
        : undefined

    return betterAuth({
        database: pool,
        secret,
        // The bearer plugin lets native clients (the Flutter app) authenticate
        // without cookies: sign-in returns the session token via the
        // `set-auth-token` response header, and getSession accepts it as
        // `Authorization: Bearer <token>`. The web app keeps using cookies —
        // this plugin is additive and does not change the cookie flow. Verifier
        // (api) and issuer (web) both go through this factory, so both speak it.
        plugins: [bearer()],
        ...(baseURL ? { baseURL } : {}),
        ...(trustedOrigins && trustedOrigins.length > 0 ? { trustedOrigins } : {}),
        ...(google
            ? {
                socialProviders: {
                    google: {
                        clientId: google.clientId,
                        clientSecret: google.clientSecret,
                    },
                },
            }
            : {}),
        emailAndPassword: {
            enabled: true,
            autoSignIn: true,
            minPasswordLength: 12,
            disableSignUp: process.env.PLEXO_DISABLE_SIGNUP === 'true',
            ...(wrappedSendResetPassword ? { sendResetPassword: wrappedSendResetPassword } : {}),
        },
        ...(wrappedSendVerificationEmail
            ? {
                emailVerification: {
                    sendOnSignUp: true,
                    autoSignInAfterVerification: true,
                    sendVerificationEmail: wrappedSendVerificationEmail,
                },
            }
            : {}),
        ...(wrappedBeforeDelete
            ? {
                user: {
                    deleteUser: {
                        enabled: true,
                        beforeDelete: wrappedBeforeDelete,
                    },
                },
            }
            : {}),
        // Better Auth v1.5.6 routes `databaseHooks.user.create.after` through
        // `queueAfterTransactionHook` — it runs AFTER the auth."user" INSERT
        // commits, so a failure here cannot roll the auth row back. The
        // workspace POST handler (apps/api/src/routes/workspaces.ts) runs the
        // same mirror inside its own transaction as a backstop. See
        // ops/coreaudit/post-audit/adr/0001-post-audit-strategy.md — recheck
        // this timing on any Better Auth v2 upgrade.
        databaseHooks: {
            user: {
                create: {
                    after: async (user: AuthUserPayload): Promise<void> => {
                        try {
                            await mirrorAuthUserToPublic(user, db)
                        } catch (err) {
                            // eslint-disable-next-line no-console
                            console.error(JSON.stringify({
                                level: 'error',
                                ns: 'auth.mirror',
                                msg: 'failed to mirror auth user into public.users; workspace POST backstop will retry on first workspace create',
                                userId: user.id,
                                email: user.email,
                                err: err instanceof Error ? err.message : String(err),
                            }))
                        }
                    },
                },
            },
        },
        advanced: {
            database: { generateId: () => randomUUID() },
            defaultCookieAttributes: {
                sameSite: 'lax' as const,
                secure: secureCookies,
                ...(cookieDomain ? { domain: cookieDomain } : {}),
            },
            ...(cookieDomain
                ? {
                    crossSubDomainCookies: {
                        enabled: true,
                        domain: cookieDomain,
                    },
                }
                : {}),
        },
    }) as unknown as Auth
}
