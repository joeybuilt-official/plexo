// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * HMAC service-key auth middleware (ADR-0002, ADR-0001 sidecar).
 *
 * Validates `X-Plexo-Signature: sha256=<hex>` over the raw request body using
 * `PLEXO_SERVICE_KEY`. For SSE / GET requests, the signature is computed over
 * the empty string and `X-Plexo-Timestamp` provides 5-minute replay protection.
 *
 * Distinct from `requireServiceKey` (Bearer token, no body binding) — HMAC is
 * required for sibling-app channel subscription and connector inbound, both of
 * which post structured bodies that must be tamper-evident.
 *
 * Express depends on a body parser running before this middleware so
 * `req.body` is the parsed JSON; we re-serialize for the signature compare.
 * Posting raw streams is not supported on these routes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { logger } from '../logger.js'

const TIMESTAMP_SKEW_MS = 5 * 60 * 1000 // 5 minutes — ADR-0002

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            plexoAppId?: string
        }
    }
}

export function requireHmacService(req: Request, res: Response, next: NextFunction): void {
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!serviceKey) {
        logger.error('PLEXO_SERVICE_KEY not configured — HMAC service auth unavailable')
        res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'service auth not configured' } })
        return
    }

    const sig = req.header('X-Plexo-Signature')
    const ts = req.header('X-Plexo-Timestamp')
    const appId = req.header('X-App-Id')

    if (!sig || !ts || !appId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'missing HMAC headers' } })
        return
    }

    const tsParsed = Date.parse(ts)
    if (Number.isNaN(tsParsed) || Math.abs(Date.now() - tsParsed) > TIMESTAMP_SKEW_MS) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'timestamp skew' } })
        return
    }

    const body = req.body && typeof req.body === 'object' && Object.keys(req.body).length
        ? JSON.stringify(req.body)
        : ''
    const expected = 'sha256=' + createHmac('sha256', serviceKey).update(body).digest('hex')

    const sigBuf = Buffer.from(sig)
    const expectedBuf = Buffer.from(expected)
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'bad signature' } })
        return
    }

    req.plexoAppId = appId
    next()
}
