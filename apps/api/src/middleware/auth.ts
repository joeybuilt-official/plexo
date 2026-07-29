// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Auth Middleware
 *
 * Routes to Better Auth session validation for user authentication.
 * Also supports internal service-key auth for SSR and app-to-Plexo calls.
 */

import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'
import { requireBetterAuth, optionalBetterAuth } from './better-auth.js'
import { eq } from 'drizzle-orm'
import { db } from '@plexo/db'
import { users } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { resolveServiceAuth } from './service-key-auth.js'

function safeEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return cryptoTimingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'))
}

// Small cache for service-key-backed user lookups — SSR renders can make
// a handful of API calls per page render, and hitting the DB for every one
// would be wasteful.
const svcUserCache = new Map<string, { user: { id: string; email: string; role: 'admin' | 'member'; isSuperAdmin: boolean }; expiry: number }>()
const SVC_CACHE_TTL_MS = 60_000

/**
 * Trusted internal-SSR path: the Next.js server forwards user identity
 * to the API using a shared service key plus X-Plexo-User-Id. The user id
 * is already validated by the Next middleware (which reads the Better Auth
 * cookie on the server side), so we only need to verify the service key
 * matches and the user exists in Plexo's users table.
 *
 * Returns true if the request was authenticated via this path.
 */
async function tryInternalServiceAuth(req: Request): Promise<boolean> {
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!serviceKey) return false

    const headerKey = req.headers['x-plexo-service-key']
    if (typeof headerKey !== 'string' || headerKey.length === 0) return false
    if (!safeEq(headerKey, serviceKey)) return false

    const headerUserId = req.headers['x-plexo-user-id']
    if (typeof headerUserId !== 'string' || !UUID_RE.test(headerUserId)) return false

    const cached = svcUserCache.get(headerUserId)
    if (cached && cached.expiry > Date.now()) {
        req.user = cached.user
        return true
    }

    try {
        const [row] = await db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(eq(users.id, headerUserId))
            .limit(1)
        if (!row) return false
        const isSuperAdmin = isSuperAdminEmail(row.email)
        const user = {
            id: row.id,
            email: row.email,
            role: (isSuperAdmin ? 'admin' : 'member') as 'admin' | 'member',
            isSuperAdmin,
        }
        svcUserCache.set(headerUserId, { user, expiry: Date.now() + SVC_CACHE_TTL_MS })
        req.user = user
        return true
    } catch (err) {
        logger.warn({ err }, 'Internal SSR auth DB lookup failed')
        return false
    }
}

function isSuperAdminEmail(email: string): boolean {
    const raw = process.env.SUPER_ADMIN_EMAILS
    if (!raw) return false
    return raw.split(',').map((e) => e.trim().toLowerCase()).includes(email.toLowerCase())
}

/**
 * App-to-Plexo service key: Levio, Fylo, etc. call workspace-scoped endpoints
 * using Authorization: Bearer <PLEXO_SERVICE_KEY> + X-App-Id. Route handlers
 * use isServiceKeyRequest() to verify this and skip user-level workspace checks.
 * req.user is NOT set — route handlers must not rely on it for these requests.
 */
async function tryAppServiceKeyAuth(req: Request): Promise<boolean> {
    const rawToken = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (!rawToken) return false
    const xAppId = req.headers['x-app-id'] as string | undefined

    // A3 dual-accept: shared PLEXO_SERVICE_KEY (X-App-Id required) OR a per-app key
    const resolved = await resolveServiceAuth(rawToken, xAppId)
    if (!resolved) return false

    const userId = req.headers['x-user-id'] as string | undefined
    req.serviceContext = {
        appId: resolved.appId,
        userId: userId && UUID_RE.test(userId) ? userId : undefined,
        viaSharedKey: resolved.viaSharedKey,
    }
    return true
}

/**
 * Requires a valid authenticated session.
 * Accepts any of:
 *   - Better Auth cookie (browser sessions)
 *   - X-Plexo-Service-Key + X-Plexo-User-Id (trusted internal SSR path)
 *   - Authorization: Bearer <PLEXO_SERVICE_KEY> + X-App-Id (app-to-Plexo calls)
 *
 * Returns 401 if no valid session is present.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Trusted internal-SSR path first — cheap header compare
    if (await tryInternalServiceAuth(req)) {
        next()
        return
    }

    // App-to-Plexo: Levio, Fylo, etc. using Bearer token + X-App-Id
    if (await tryAppServiceKeyAuth(req)) {
        next()
        return
    }

    return requireBetterAuth(req, res, next)
}

/**
 * Optional auth: attaches req.user if a valid session is present.
 * Calls next() regardless — does NOT return 401 on missing session.
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (await tryInternalServiceAuth(req)) {
        next()
        return
    }
    return optionalBetterAuth(req, res, next)
}
