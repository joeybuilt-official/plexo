// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Super-Admin Gate Middleware
 *
 * Requires a valid Supabase JWT user with `isSuperAdmin = true`.
 * Must be stacked AFTER requireSupabaseAuth middleware.
 */

import type { Request, Response, NextFunction } from 'express'

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
        return
    }

    if (!req.user.isSuperAdmin) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Super-admin access required' } })
        return
    }

    next()
}
