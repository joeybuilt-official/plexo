// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Better Auth Session Middleware
 *
 * Validates sessions issued by the shared Better Auth instance (auth schema).
 * Used when AUTH_PROVIDER=better-auth (Plexo-Ops instance) — allows operators who
 * signed up via Command Center to authenticate into Plexo with the same credentials.
 *
 * Requires env:
 *   AUTH_DATABASE_URL — connection string to the shared DB (auth schema lives there)
 *   AUTH_SECRET       — same secret configured in Command Center's Better Auth instance
 */

import type { Request, Response, NextFunction } from 'express'

export interface PlexoUser {
    id: string
    email: string
    role: 'admin' | 'member'
    isSuperAdmin: boolean
}

// Extend Express Request with authenticated user
declare global {
    namespace Express {
        interface Request {
            user?: PlexoUser
        }
    }
}

import type { Auth } from 'better-auth'
import { betterAuth } from 'better-auth'
import { Pool } from 'pg'
import { logger } from '../logger.js'

let _authInstance: Auth | null = null

function getAuth(): Auth {
    if (_authInstance) return _authInstance

    const url = process.env.AUTH_DATABASE_URL
    const secret = process.env.AUTH_SECRET
    if (!url || !secret) {
        throw new Error('[better-auth] AUTH_DATABASE_URL and AUTH_SECRET must be set')
    }

    const pool = new Pool({ connectionString: url })
    pool.on('connect', (client) => {
        client.query('SET search_path TO auth').catch((err: unknown) => {
            logger.warn({ err }, '[better-auth] Failed to set search_path')
        })
    })

    _authInstance = betterAuth({
        database: pool,
        secret,
        emailAndPassword: { enabled: true },
    }) as Auth

    return _authInstance
}

/**
 * Middleware: requires a valid Better Auth session.
 * Accepts session token via:
 *   - Authorization: Bearer <token>
 *   - Cookie: better-auth.session_token=<token>
 */
export async function requireBetterAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const incomingHeaders = new Headers()

    const authHeader = req.headers.authorization
    if (authHeader) incomingHeaders.set('authorization', authHeader)

    const cookieHeader = req.headers.cookie
    if (cookieHeader) incomingHeaders.set('cookie', cookieHeader)

    try {
        const auth = getAuth()
        const session = await auth.api.getSession({ headers: incomingHeaders })

        if (!session?.user?.id || !session.user.email) {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired session' } })
            return
        }

        req.user = await resolveUser(session.user.id, session.user.email)
        next()
    } catch (err) {
        logger.debug({ err }, '[better-auth] Session validation failed')
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Auth validation failed' } })
    }
}

// In-memory cache: avoids a DB round-trip on every request
const userCache = new Map<string, { user: { id: string; email: string; role: 'admin' | 'member'; isSuperAdmin: boolean }; expiry: number }>()
const CACHE_TTL_MS = 60_000

function isSuperAdminEmail(email: string): boolean {
    const raw = process.env.SUPER_ADMIN_EMAILS
    if (!raw) return false
    return raw.split(',').map((e) => e.trim().toLowerCase()).includes(email.toLowerCase())
}

/**
 * Resolves req.user from a Better Auth session.
 *
 * Since users live in `auth.user` (exposed to plexo via postgres_fdw),
 * Plexo no longer owns the users table. Super-admin and role are derived from
 * env var SUPER_ADMIN_EMAILS + the Better Auth session claims — no local
 * writes needed.
 */
async function resolveUser(id: string, email: string) {
    const cached = userCache.get(id)
    if (cached && cached.expiry > Date.now()) return cached.user

    const isSuperAdmin = isSuperAdminEmail(email)
    const role: 'admin' | 'member' = isSuperAdmin ? 'admin' : 'member'

    const user = { id, email, role, isSuperAdmin }
    userCache.set(id, { user, expiry: Date.now() + CACHE_TTL_MS })
    return user
}
/**
 * Optional auth: attaches req.user if a valid Better Auth session is present.
 * Calls next() regardless — does NOT return 401 on missing or invalid session.
 */
export async function optionalBetterAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const incomingHeaders = new Headers()

    const authHeader = req.headers.authorization
    if (authHeader) incomingHeaders.set('authorization', authHeader)

    const cookieHeader = req.headers.cookie
    if (cookieHeader) incomingHeaders.set('cookie', cookieHeader)

    try {
        const auth = getAuth()
        const session = await auth.api.getSession({ headers: incomingHeaders })
        if (session?.user?.id && session.user.email) {
            req.user = await resolveUser(session.user.id, session.user.email)
        }
    } catch (err) {
        logger.debug({ err }, '[better-auth] Optional session validation failed')
    }

    next()
}
