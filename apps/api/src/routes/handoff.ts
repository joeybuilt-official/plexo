// SPDX-License-Identifier: MIT
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
import * as handoffRepo from '../repositories/handoff.repository.js'
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
        await handoffRepo.insertToken(token, user.id, targetApp, expiresAt.toISOString())

        const redirectUrl = `${KNOWN_APPS[targetApp]}/auth/handshake?token=${token}&from=plexo`
        logger.info({ userId: user.id, targetApp }, 'Cross-app handoff token generated')
        res.json({ token, redirectUrl, expiresAt: expiresAt.toISOString() })
    } catch (err) {
        logger.error({ err }, 'Failed to generate handoff token')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate token' } })
    }
})

/**
 * GET /api/auth/handoff/initiate?targetApp=levio
 * Redirect-based SSO initiation — generates a token and redirects to the target app's handshake page.
 * Returns 302 to the target app, or 302 to Plexo login if not authenticated.
 */
handoffRouter.get('/initiate', async (req, res, next) => {
    const { targetApp } = req.query as { targetApp?: string }

    if (!targetApp || !KNOWN_APPS[targetApp]) {
        res.status(400).json({ error: 'unknown target app' })
        return
    }

    // Use requireAuth inline — if no session, redirect to Plexo login
    const session = (req as { user?: { id: string } }).user
    if (!session) {
        const loginUrl = `${KNOWN_APPS['plexo'] || ''}/login?redirect_to=${encodeURIComponent(KNOWN_APPS[targetApp])}`
        res.redirect(302, loginUrl)
        return
    }

    requireAuth(req, res, async () => {
        const user = req.user!
        const token = randomBytes(32).toString('hex')
        const expiresAt = new Date(Date.now() + 30_000)
        try {
            await handoffRepo.insertToken(token, user.id, targetApp, expiresAt.toISOString())
            const redirectUrl = `${KNOWN_APPS[targetApp]}/auth/handshake?token=${token}&from=plexo`
            logger.info({ userId: user.id, targetApp }, 'Cross-app SSO initiation redirect')
            res.redirect(302, redirectUrl)
        } catch (err) {
            logger.error({ err }, 'Failed to initiate SSO redirect')
            next(err)
        }
    })
})

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
        const rows = await handoffRepo.consumeToken(token)

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
