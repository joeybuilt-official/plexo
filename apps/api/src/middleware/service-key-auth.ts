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
 *   X-User-Id: <supabase_user_uuid>  (for user attribution)
 */

import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'
import { logger } from '../logger.js'

export interface ServiceContext {
    appId: string
    userId?: string  // Supabase user ID if provided via X-User-Id header
}

// Extend Express Request
declare module 'express' {
    interface Request {
        serviceContext?: ServiceContext
    }
}

/**
 * Validates the PLEXO_SERVICE_KEY and extracts app identity.
 * Returns 401 if key is missing/invalid, 400 if X-App-Id is missing.
 */
export function requireServiceKey(req: Request, res: Response, next: NextFunction): void {
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!serviceKey) {
        logger.error('PLEXO_SERVICE_KEY not configured — service key auth unavailable')
        res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Service key auth not configured' } })
        return
    }

    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
        return
    }

    const token = authHeader.slice(7)

    // Constant-time comparison to prevent timing attacks
    if (!timingSafeEqual(token, serviceKey)) {
        res.status(401).json({ error: { code: 'INVALID_KEY', message: 'Invalid service key' } })
        return
    }

    const appId = req.headers['x-app-id'] as string | undefined
    if (!appId) {
        res.status(400).json({ error: { code: 'MISSING_APP_ID', message: 'X-App-Id header required' } })
        return
    }

    const userId = req.headers['x-user-id'] as string | undefined

    req.serviceContext = { appId, userId }
    next()
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
