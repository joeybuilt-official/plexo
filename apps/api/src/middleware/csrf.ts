// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * CSRF protection — Origin / Referer validation for cookie-authed sessions.
 *
 * Strategy: for state-changing methods (POST, PUT, PATCH, DELETE) we require
 * the Origin header (or Referer as fallback) to match an allow-listed origin
 * when the request is authenticated via a browser cookie. This is the OWASP
 * "Verifying Origin With Standard Headers" pattern and is a well-known
 * pragmatic defense for SPAs when paired with SameSite=lax cookies (which
 * Better Auth sets by default).
 *
 * Exemptions (CSRF does NOT apply):
 *   - Bearer token auth (api_keys) — no cookies means no CSRF surface.
 *   - Internal-SSR service-key auth (X-Plexo-Service-Key) — server-to-server,
 *     the browser can't forge a shared secret header cross-origin.
 *   - Webhook routes — they use provider HMAC signatures, not cookies.
 *   - Read-only methods (GET, HEAD, OPTIONS).
 *
 * Rejection is 403 with a structured error the UI can surface.
 */
import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'
import { logger } from '../logger.js'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function createOriginCsrfMiddleware(allowedOrigins: Set<string>) {
    return function originCsrf(req: Request, res: Response, next: NextFunction): void {
        // Read-only methods never need CSRF
        if (!MUTATING_METHODS.has(req.method)) {
            next()
            return
        }

        // Service-key auth (internal SSR) bypasses CSRF — but ONLY when the key
        // actually matches the configured secret. A bare presence check would let
        // an attacker bypass CSRF by sending any value in this header.
        const serviceKeyHeader = req.headers['x-plexo-service-key']
        const configuredServiceKey = process.env.PLEXO_SERVICE_KEY
        if (typeof serviceKeyHeader === 'string' && serviceKeyHeader.length > 0 &&
            configuredServiceKey && serviceKeyHeader.length === configuredServiceKey.length &&
            cryptoTimingSafeEqual(Buffer.from(serviceKeyHeader, 'utf-8'), Buffer.from(configuredServiceKey, 'utf-8'))) {
            next()
            return
        }

        // Bearer-token auth (API keys) bypasses CSRF — browsers don't attach Authorization
        // headers on cross-origin forged requests without explicit fetch() in the attacker's
        // page, which already requires CORS to succeed (and our CORS allowlist blocks that).
        const authHeader = req.headers.authorization
        if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
            next()
            return
        }

        // Browser cookie auth — require Origin or Referer header match
        const origin = (req.headers.origin as string | undefined) ?? ''
        const referer = (req.headers.referer as string | undefined) ?? ''

        // Derive origin from Referer if Origin not set (some browsers omit it on same-origin)
        let candidate = origin
        if (!candidate && referer) {
            try {
                const u = new URL(referer)
                candidate = `${u.protocol}//${u.host}`
            } catch {
                // Fall through: candidate stays empty → reject
            }
        }

        if (!candidate) {
            logger.warn({ path: req.path, method: req.method }, 'CSRF: missing Origin and Referer')
            res.status(403).json({
                error: { code: 'CSRF_MISSING_ORIGIN', message: 'Origin or Referer header required' },
            })
            return
        }

        if (!allowedOrigins.has(candidate)) {
            logger.warn({ path: req.path, method: req.method, origin: candidate }, 'CSRF: origin not allowed')
            res.status(403).json({
                error: { code: 'CSRF_ORIGIN_MISMATCH', message: 'Origin not allowed for state-changing request' },
            })
            return
        }

        next()
    }
}
