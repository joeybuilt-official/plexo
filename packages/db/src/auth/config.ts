// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { betterAuth, type Auth } from 'better-auth'
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'

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
