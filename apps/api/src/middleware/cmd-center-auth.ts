// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Command Center Auth Middleware
 *
 * Accepts EITHER:
 *   1. Supabase JWT (super-admin user) — for browser-initiated requests
 *   2. PLEXO_SERVICE_KEY + X-App-Id: command-center — for server-side CC app calls
 *
 * This allows the Command Center Next.js app to call cmd-center routes from
 * server components without a user session (using the service key), while
 * still supporting user-authenticated requests from the browser.
 */

import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'
import { requireSupabaseAuth } from './supabase-auth.js'
import { requireSuperAdmin } from './super-admin.js'
import { logger } from '../logger.js'

export async function cmdCenterAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } })
        return
    }

    const token = authHeader.slice(7)
    const appId = req.headers['x-app-id'] as string | undefined
    const serviceKey = process.env.PLEXO_SERVICE_KEY

    // Path 1: Service key auth (CC app server-side calls)
    if (appId === 'command-center' && serviceKey && token.length < 100) {
        // Service keys are short strings, JWTs are 200+ chars
        if (timingSafeEqual(token, serviceKey)) {
            // Service key valid — grant super-admin access without a user
            req.user = {
                id: 'service:command-center',
                email: 'command-center@internal.joeybuilt.com',
                role: 'admin',
                isSuperAdmin: true,
            }
            next()
            return
        }
        res.status(401).json({ error: { code: 'INVALID_KEY', message: 'Invalid service key' } })
        return
    }

    // Path 2: Supabase JWT auth (user in browser)
    requireSupabaseAuth(req, res, (err?: unknown) => {
        if (err || res.headersSent) return
        requireSuperAdmin(req, res, next)
    })
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    const bufA = Buffer.from(a, 'utf-8')
    const bufB = Buffer.from(b, 'utf-8')
    return cryptoTimingSafeEqual(bufA, bufB)
}
