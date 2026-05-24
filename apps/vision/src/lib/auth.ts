// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Service-key bearer auth middleware.
 *
 * The vision service is internal infrastructure called by apps/api over the
 * docker compose network. All mutating routes require:
 *
 *     Authorization: Bearer ${PLEXO_SERVICE_KEY}
 *
 * Health / model-listing routes are exempt so docker healthchecks and the
 * intelligence-dashboard wizard can probe readiness without credentials.
 *
 * NOTE — this matches the existing PLEXO_SERVICE_KEY env Plexo uses for
 * api ↔ sidecar HMAC (see apps/gmessages/internal/httpauth/hmac.go). The
 * vision service uses the simpler Bearer scheme because the call shape is
 * a straight RPC, not a webhook with a replayable body.
 */

import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { childLogger } from './logger.js'

const logger = childLogger('auth')

const serviceKey = process.env.PLEXO_SERVICE_KEY ?? ''

if (!serviceKey) {
    logger.warn(
        'PLEXO_SERVICE_KEY is unset — service will reject all authenticated requests. ' +
            'Set this in your environment before running outside a dev shell.',
    )
}

function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'))
}

export function requireServiceKey(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    if (!serviceKey) {
        res.status(503).json({
            error: { message: 'PLEXO_SERVICE_KEY not configured', type: 'server_error' },
        })
        return
    }

    const header = req.headers.authorization ?? ''
    const prefix = 'Bearer '
    if (!header.startsWith(prefix)) {
        res.status(401).json({
            error: { message: 'Missing bearer token', type: 'auth_error' },
        })
        return
    }

    const token = header.slice(prefix.length)
    if (!constantTimeEqual(token, serviceKey)) {
        res.status(401).json({
            error: { message: 'Invalid service key', type: 'auth_error' },
        })
        return
    }

    next()
}
