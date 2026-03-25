// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Supabase JWT Auth Middleware
 *
 * Validates JWTs issued by the shared joeybuilt-platform Supabase instance.
 * On first request from a new user, upserts into Plexo's users table.
 * Attaches `req.user` with { id, email, role, isSuperAdmin }.
 */

import type { Request, Response, NextFunction } from 'express'
import { jwtVerify, createLocalJWKSet, type JWTPayload } from 'jose'
import { db, eq } from '@plexo/db'
import { users } from '@plexo/db'
import { logger } from '../logger.js'

export interface PlexoUser {
    id: string
    email: string
    role: 'admin' | 'member'
    isSuperAdmin: boolean
}

// Extend Express Request
declare global {
    namespace Express {
        interface Request {
            user?: PlexoUser
        }
    }
}

// JWT secret from env — the Supabase JWT secret (HS256)
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET

let secretKey: Uint8Array | null = null

function getSecretKey(): Uint8Array {
    if (secretKey) return secretKey
    if (!JWT_SECRET) throw new Error('SUPABASE_JWT_SECRET not configured')
    secretKey = new TextEncoder().encode(JWT_SECRET)
    return secretKey
}

interface SupabaseJWTPayload extends JWTPayload {
    sub?: string
    email?: string
    role?: string
    user_metadata?: {
        full_name?: string
        name?: string
        avatar_url?: string
    }
}

/**
 * Middleware that requires a valid Supabase JWT.
 * Returns 401 if missing or invalid.
 */
export async function requireSupabaseAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
        return
    }

    const token = authHeader.slice(7)

    try {
        const { payload } = await jwtVerify(token, getSecretKey(), {
            clockTolerance: 30, // 30s tolerance for clock skew
            issuer: 'supabase',
        }) as { payload: SupabaseJWTPayload }

        const userId = payload.sub
        const email = payload.email

        if (!userId || !email) {
            res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Token missing sub or email' } })
            return
        }

        // Upsert user into Plexo's users table on first seen
        const plexoUser = await upsertUser(userId, email, payload.user_metadata)

        req.user = plexoUser
        next()
    } catch (err) {
        logger.debug({ err }, 'JWT verification failed')
        res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } })
    }
}

/**
 * Optional auth: if a valid JWT is present, attach user. Otherwise continue without auth.
 */
export async function optionalSupabaseAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        next()
        return
    }

    const token = authHeader.slice(7)

    try {
        const { payload } = await jwtVerify(token, getSecretKey(), {
            clockTolerance: 30,
            issuer: 'supabase',
        }) as { payload: SupabaseJWTPayload }

        const userId = payload.sub
        const email = payload.email

        if (userId && email) {
            req.user = await upsertUser(userId, email, payload.user_metadata)
        }
    } catch {
        // Optional — swallow errors silently
    }

    next()
}

// In-memory cache to avoid DB hit on every request
const userCache = new Map<string, { user: PlexoUser; expiry: number }>()
const CACHE_TTL_MS = 60_000 // 1 minute

/**
 * Parse SUPER_ADMIN_EMAILS env var (comma-separated, case-insensitive).
 * Users whose email matches are auto-promoted to super admin on login.
 */
function isSuperAdminEmail(email: string): boolean {
    const raw = process.env.SUPER_ADMIN_EMAILS
    if (!raw) return false
    return raw.split(',').map(e => e.trim().toLowerCase()).includes(email.toLowerCase())
}

async function upsertUser(
    supabaseId: string,
    email: string,
    metadata?: SupabaseJWTPayload['user_metadata'],
): Promise<PlexoUser> {
    // Check cache first
    const cached = userCache.get(supabaseId)
    if (cached && cached.expiry > Date.now()) {
        return cached.user
    }

    const shouldBeSuperAdmin = isSuperAdminEmail(email)

    // Try to find existing user
    let [existing] = await db
        .select({
            id: users.id,
            email: users.email,
            role: users.role,
            isSuperAdmin: users.isSuperAdmin,
        })
        .from(users)
        .where(eq(users.id, supabaseId))
        .limit(1)

    if (!existing) {
        // First time this Supabase user hits Plexo — create a row
        const name = metadata?.full_name ?? metadata?.name ?? email.split('@')[0]
        const image = metadata?.avatar_url

        const [inserted] = await db.insert(users).values({
            id: supabaseId,
            email,
            name,
            image,
            role: shouldBeSuperAdmin ? 'admin' : 'member',
            isSuperAdmin: shouldBeSuperAdmin,
        }).onConflictDoNothing().returning({
            id: users.id,
            email: users.email,
            role: users.role,
            isSuperAdmin: users.isSuperAdmin,
        })

        // onConflictDoNothing might not return a row if race condition
        if (!inserted) {
            [existing] = await db
                .select({
                    id: users.id,
                    email: users.email,
                    role: users.role,
                    isSuperAdmin: users.isSuperAdmin,
                })
                .from(users)
                .where(eq(users.id, supabaseId))
                .limit(1)
        } else {
            existing = inserted
            logger.info({ userId: supabaseId, email, isSuperAdmin: shouldBeSuperAdmin }, 'New user auto-provisioned from Supabase JWT')
        }
    } else if (shouldBeSuperAdmin && !existing.isSuperAdmin) {
        // Existing user whose email is now in SUPER_ADMIN_EMAILS — promote them
        await db.update(users).set({ isSuperAdmin: true, role: 'admin' }).where(eq(users.id, supabaseId))
        existing = { ...existing, isSuperAdmin: true, role: 'admin' }
        logger.info({ userId: supabaseId, email }, 'User promoted to super admin via SUPER_ADMIN_EMAILS')
    }

    const plexoUser: PlexoUser = {
        id: existing!.id,
        email: existing!.email,
        role: existing!.role,
        isSuperAdmin: existing!.isSuperAdmin,
    }

    // Cache
    userCache.set(supabaseId, { user: plexoUser, expiry: Date.now() + CACHE_TTL_MS })

    return plexoUser
}
