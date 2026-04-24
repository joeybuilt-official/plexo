// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cross-App Token Handoff
 *
 * Allows authenticated users to navigate between Joeybuilt apps
 * without re-entering credentials.
 *
 * POST /api/auth/handoff/generate
 *   - Requires active session
 *   - Returns a 30-second single-use token + redirect URL
 *
 * POST /api/auth/handoff/consume
 *   - Validates + burns the token
 *   - Returns userId so the target app can create a local session
 */

import { Router, type Router as RouterType } from 'express'
import { randomBytes } from 'crypto'
import { db, sql } from '@plexo/db'
import { requireAuth } from '../middleware/auth.js'
import { logger } from '../logger.js'

export const handoffRouter: RouterType = Router()

const KNOWN_APPS: Record<string, string> = {
    plexo: process.env.PUBLIC_URL ?? '',
    // Add sibling apps here if cross-app SSO handoff is needed.
    // Each entry needs a corresponding env var (e.g. MY_APP_PUBLIC_URL).
    ...(process.env.CC_PUBLIC_URL ? { cc: process.env.CC_PUBLIC_URL } : {}),
    ...(process.env.FYLO_PUBLIC_URL ? { fylo: process.env.FYLO_PUBLIC_URL } : {}),
    ...(process.env.LEVIO_PUBLIC_URL ? { levio: process.env.LEVIO_PUBLIC_URL } : {}),
    ...(process.env.PUSHD_PUBLIC_URL ? { pushd: process.env.PUSHD_PUBLIC_URL } : {}),
}

/**
 * POST /api/auth/handoff/generate
 * Body: { targetApp: "cc" | "fylo" | "levio" | ... }
 * Returns: { token, redirectUrl, expiresAt }
 */
handoffRouter.post('/generate', requireAuth, async (req, res) => {
    const { targetApp } = req.body as { targetApp?: string }

    if (!targetApp || typeof targetApp !== 'string' || !KNOWN_APPS[targetApp]) {
        res.status(400).json({
            error: {
                code: 'INVALID_TARGET',
                message: `Unknown target app. Known apps: ${Object.keys(KNOWN_APPS).join(', ')}`,
            },
        })
        return
    }

    const user = req.user!
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 30_000) // 30 seconds

    try {
        await db.execute(sql`
            INSERT INTO auth.cross_app_tokens (token, user_id, source_app, target_app, expires_at)
            VALUES (${token}, ${user.id}::uuid, 'plexo', ${targetApp}, ${expiresAt.toISOString()})
        `)

        const redirectUrl = `${KNOWN_APPS[targetApp]}/auth/handshake?token=${token}&from=plexo`
        logger.info({ userId: user.id, targetApp }, 'Cross-app handoff token generated')
        res.json({ token, redirectUrl, expiresAt: expiresAt.toISOString() })
    } catch (err) {
        logger.error({ err }, 'Failed to generate handoff token')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate token' } })
    }
})

interface TokenRow extends Record<string, unknown> {
    user_id: string
    source_app: string
    target_app: string
}

/**
 * POST /api/auth/handoff/consume
 * Body: { token }
 * Returns: { userId, sourceApp } — used by target app to establish a local session
 */
handoffRouter.post('/consume', async (req, res) => {
    const { token } = req.body as { token?: string }

    if (!token || typeof token !== 'string' || token.length !== 64) {
        res.status(400).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid token format' } })
        return
    }

    try {
        const rows = await db.execute<TokenRow>(sql`
            UPDATE auth.cross_app_tokens
            SET used = true
            WHERE token = ${token}
              AND used = false
              AND expires_at > now()
            RETURNING user_id, source_app, target_app
        `)

        if (rows.length === 0) {
            res.status(401).json({ error: { code: 'TOKEN_INVALID', message: 'Token expired, used, or not found' } })
            return
        }

        const row = rows[0]!
        logger.info({ userId: row.user_id, sourceApp: row.source_app, targetApp: row.target_app }, 'Cross-app handoff consumed')
        res.json({ userId: row.user_id, sourceApp: row.source_app })
    } catch (err) {
        logger.error({ err }, 'Failed to consume handoff token')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to consume token' } })
    }
})
