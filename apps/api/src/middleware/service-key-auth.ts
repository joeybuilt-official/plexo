// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Service Key Auth Middleware
 *
 * Validates PLEXO_SERVICE_KEY for app↔Plexo service-to-service calls.
 * Each Joeybuilt app shares a service key with Plexo for backend communication.
 *
 * Requests must include:
 *   Authorization: Bearer <PLEXO_SERVICE_KEY>
 *   X-App-Id: <app_slug>  (e.g., "fylo", "nexalog")
 *
 * Optionally:
 *   X-User-Id: <user_uuid>  (for user attribution)
 */

import type { Request, Response, NextFunction } from 'express'
import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { listActiveForAuth, touchLastUsed } from '../repositories/app-service-keys.repository.js'

export interface ServiceContext {
    appId: string
    userId?: string  // User ID if provided via X-User-Id header
    viaSharedKey?: boolean  // true = legacy shared PLEXO_SERVICE_KEY; false = per-app key (A3)
}

/**
 * A3 dual-accept core. Validates an incoming Bearer token as EITHER the legacy
 * shared PLEXO_SERVICE_KEY (X-App-Id required to name the caller) OR a per-app
 * key (`psk_…` from app_service_keys; the key itself identifies the app, so
 * X-App-Id is optional but must match if supplied). Constant-time throughout.
 * Returns the resolved appId, or null when the token is not valid.
 */
export async function resolveServiceAuth(
    token: string,
    headerAppId: string | undefined,
): Promise<{ appId: string; viaSharedKey: boolean } | null> {
    // Legacy shared key path
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (serviceKey && timingSafeEqual(token, serviceKey)) {
        if (!headerAppId) return null
        return { appId: headerAppId, viaSharedKey: true }
    }
    // Per-app key path (A3). Only psk_-prefixed tokens hit the DB.
    if (token.startsWith('psk_')) {
        try {
            const candidates = await listActiveForAuth(headerAppId)
            const now = Date.now()
            for (const k of candidates) {
                if (k.expiresAt && k.expiresAt.getTime() < now) continue
                const hash = createHash('sha256').update(token + k.tokenSalt).digest('hex')
                if (hash.length === k.tokenHash.length
                    && cryptoTimingSafeEqual(Buffer.from(hash, 'utf-8'), Buffer.from(k.tokenHash, 'utf-8'))) {
                    if (headerAppId && headerAppId !== k.appId) return null
                    void touchLastUsed(k.id).catch((err: unknown) =>
                        logger.warn({ err }, 'app-service-key touchLastUsed failed'))
                    return { appId: k.appId, viaSharedKey: false }
                }
            }
        } catch (err) {
            logger.error({ err }, 'per-app service key validation failed')
        }
    }
    return null
}

// Extend Express Request
declare global {
    namespace Express {
        interface Request {
            serviceContext?: ServiceContext
        }
    }
}

/**
 * Validates the PLEXO_SERVICE_KEY and extracts app identity.
 * Returns 401 if key is missing/invalid, 400 if X-App-Id is missing.
 */
export async function requireServiceKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
        return
    }

    const token = authHeader.slice(7)
    const headerAppId = req.headers['x-app-id'] as string | undefined

    // A3 dual-accept: shared PLEXO_SERVICE_KEY OR a per-app key
    const resolved = await resolveServiceAuth(token, headerAppId)
    if (!resolved) {
        res.status(401).json({ error: { code: 'INVALID_KEY', message: 'Invalid service key' } })
        return
    }

    const userId = req.headers['x-user-id'] as string | undefined
    if (userId !== undefined && !UUID_RE.test(userId)) {
        res.status(400).json({ error: { code: 'INVALID_USER_ID', message: 'X-User-Id must be a valid UUID' } })
        return
    }

    req.serviceContext = { appId: resolved.appId, userId, viaSharedKey: resolved.viaSharedKey }
    next()
}

/**
 * Jex mesh service-key auth: a Bearer-only variant of requireServiceKey for the
 * cross-app identity mesh (ADR-0016 B3). The mesh contract carries the calling
 * appId in the request BODY (recognition) or omits it entirely (profile GET),
 * so — unlike requireServiceKey — X-App-Id is NOT required alongside the shared
 * PLEXO_SERVICE_KEY. Per-app `psk_` keys still resolve (they self-identify).
 * Same key material, same constant-time compare — no new auth scheme.
 */
export async function requireMeshServiceKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
        return
    }

    const token = authHeader.slice(7)
    const headerAppId = req.headers['x-app-id'] as string | undefined

    // Shared PLEXO_SERVICE_KEY — accepted Bearer-only (mesh contract has no X-App-Id header).
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (serviceKey && timingSafeEqual(token, serviceKey)) {
        req.serviceContext = { appId: headerAppId ?? 'mesh', viaSharedKey: true }
        next()
        return
    }

    // Per-app key (A3) — self-identifying, X-App-Id optional.
    const resolved = await resolveServiceAuth(token, headerAppId)
    if (resolved) {
        req.serviceContext = { appId: resolved.appId, viaSharedKey: resolved.viaSharedKey }
        next()
        return
    }

    res.status(401).json({ error: { code: 'INVALID_KEY', message: 'Invalid service key' } })
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    const bufA = Buffer.from(a, 'utf-8')
    const bufB = Buffer.from(b, 'utf-8')
    return cryptoTimingSafeEqual(bufA, bufB)
}
