// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Universal Plexo SSO — Phase 1 (Plexo IdP side only).
 *
 * Two endpoints, both gated by the PLEXO_SSO_ENABLED feature flag:
 *
 *   GET  /api/sso/handoff?app=<slug>&return=<url>
 *     Browser-driven. If the caller has a valid Plexo session, mint a
 *     short-lived HMAC-signed token and 302 to the sibling app's return
 *     URL with `?sso_token=…`. Otherwise 302 to /auth/login?next=…
 *
 *   POST /api/sso/verify  { token, appSlug }
 *     Server-to-server. Sibling app's callback handler calls this after
 *     receiving sso_token. Verifies HMAC + expiry + single-use, then
 *     returns { valid: true, userId, email }. Token is burned in Redis
 *     so a replay returns 401.
 *
 * Phase 2+ (one sibling at a time, with soak) wires up the receiving
 * side in each app. Until then, sibling apps keep their existing login.
 */

import { Router, type Router as RouterType } from 'express'
import { logger } from '../logger.js'
import { optionalAuth } from '../middleware/auth.js'
import { getRedis } from '../redis-client.js'
import * as ssoRepo from '../repositories/sso.repository.js'
import {
    getSsoSecret,
    isAllowedAppSlug,
    isSsoEnabled,
    SSO_ALLOWED_APPS,
    validateReturnUrl,
} from '../sso/config.js'
import { markUsedOnce, mintToken, verifyToken } from '../sso/token.js'

export const ssoRouter: RouterType = Router()

function flagOff(res: import('express').Response): void {
    res.status(503).json({
        error: {
            code: 'SSO_DISABLED',
            message: 'Plexo universal SSO is not enabled on this instance',
        },
    })
}

// ── GET /api/sso/handoff ─────────────────────────────────────────────────
// Mounted under /api/sso, so this matches /api/sso/handoff exactly.
ssoRouter.get('/handoff', optionalAuth, async (req, res) => {
    if (!isSsoEnabled()) return flagOff(res)

    const secret = getSsoSecret()
    if (!secret) {
        logger.error('SSO_HANDOFF_SECRET missing or too short — SSO disabled at runtime')
        return flagOff(res)
    }

    const appSlug = String(req.query.app ?? '')
    const returnRaw = String(req.query.return ?? '')

    if (!isAllowedAppSlug(appSlug)) {
        res.status(400).json({
            error: {
                code: 'INVALID_APP_SLUG',
                message: `app must be one of: ${Object.keys(SSO_ALLOWED_APPS).join(', ')}`,
            },
        })
        return
    }

    const returnUrl = validateReturnUrl(appSlug, returnRaw)
    if (!returnUrl) {
        res.status(400).json({
            error: {
                code: 'INVALID_RETURN_URL',
                message: 'return URL must be https and host must match the requested app',
            },
        })
        return
    }

    // No session: bounce to Plexo login, preserving the original handoff
    // URL so we land back here after auth.
    if (!req.user) {
        const publicUrl = process.env.PUBLIC_URL ?? ''
        const currentPath = `/api/sso/handoff?app=${encodeURIComponent(appSlug)}&return=${encodeURIComponent(returnRaw)}`
        const next = publicUrl ? `${publicUrl}${currentPath}` : currentPath
        const loginUrl = `${publicUrl}/auth/login?next=${encodeURIComponent(next)}`
        res.redirect(302, loginUrl)
        return
    }

    const { token, payload } = mintToken(secret, {
        userId: req.user.id,
        appSlug,
    })

    // Pre-register the jti as "minted but not yet used" — actually we only
    // need to record state ON verify (single-use). Skip a write here to
    // keep the handoff path Redis-light; verify is where the SET NX gate
    // lives.

    logger.info(
        { userId: req.user.id, appSlug, jti: payload.jti, exp: payload.exp },
        'SSO handoff token minted',
    )

    returnUrl.searchParams.set('sso_token', token)
    res.redirect(302, returnUrl.toString())
})

// ── POST /api/sso/verify ─────────────────────────────────────────────────
ssoRouter.post('/verify', async (req, res) => {
    if (!isSsoEnabled()) return flagOff(res)

    const secret = getSsoSecret()
    if (!secret) {
        logger.error('SSO_HANDOFF_SECRET missing or too short — SSO disabled at runtime')
        return flagOff(res)
    }

    const body = req.body as { token?: unknown; appSlug?: unknown }
    const token = typeof body.token === 'string' ? body.token : ''
    const appSlug = typeof body.appSlug === 'string' ? body.appSlug : ''

    if (!token || !appSlug) {
        res.status(400).json({
            error: { code: 'INVALID_BODY', message: 'token and appSlug are required strings' },
        })
        return
    }
    if (!isAllowedAppSlug(appSlug)) {
        res.status(400).json({
            error: {
                code: 'INVALID_APP_SLUG',
                message: `appSlug must be one of: ${Object.keys(SSO_ALLOWED_APPS).join(', ')}`,
            },
        })
        return
    }

    const result = verifyToken(secret, token, appSlug)
    if (!result.ok) {
        // All failure cases collapse to a single 401 — don't leak which
        // check failed. Log internally for debugging.
        logger.info({ appSlug, reason: result.reason }, 'SSO verify rejected')
        res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Token invalid or expired' } })
        return
    }

    // Single-use enforcement: SET NX on the jti. Race-safe.
    let firstUse = false
    try {
        const redis = await getRedis()
        firstUse = await markUsedOnce(redis, result.payload.jti)
    } catch (err) {
        logger.error({ err }, 'SSO verify: Redis markUsedOnce failed — refusing to validate')
        res.status(503).json({
            error: { code: 'STATE_UNAVAILABLE', message: 'Single-use store unavailable' },
        })
        return
    }

    if (!firstUse) {
        logger.warn(
            { userId: result.payload.userId, appSlug, jti: result.payload.jti },
            'SSO verify rejected — token already consumed',
        )
        res.status(401).json({ error: { code: 'TOKEN_USED', message: 'Token already consumed' } })
        return
    }

    // Look up email so the sibling app can match by email if needed.
    // Users live in `auth.user` (exposed in our DB via postgres_fdw),
    // but querying the foreign table directly works the same.
    let email = ''
    try {
        const rows = await ssoRepo.getUserEmail(result.payload.userId)
        if (rows.length === 0) {
            logger.warn({ userId: result.payload.userId }, 'SSO verify: user not found in auth.user')
            res.status(401).json({ error: { code: 'USER_NOT_FOUND', message: 'User no longer exists' } })
            return
        }
        email = String(rows[0]?.email ?? '')
    } catch (err) {
        logger.error({ err }, 'SSO verify: user lookup failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Verify failed' } })
        return
    }

    logger.info(
        { userId: result.payload.userId, appSlug, jti: result.payload.jti },
        'SSO verify accepted',
    )
    res.json({ valid: true, userId: result.payload.userId, email })
})
