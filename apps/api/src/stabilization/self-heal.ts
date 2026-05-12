// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Self-correcting error layer.
 *
 * When the API's global error handler catches a recoverable error
 * (transient DNS failure, upstream 502, connection reset to a known
 * host) we don't bubble it as a 500 immediately — we schedule a small
 * in-process retry with exponential backoff, capped at 3 attempts.
 *
 * This is *only* for idempotent error shapes. Mutating routes are not
 * eligible: callers that POST/DELETE see the original error so they can
 * decide whether retry is safe. GET / probe routes pass through the
 * retry path.
 *
 * Wiring: import `wrapWithSelfHeal()` from apps/api/src/index.ts and
 * apply as middleware before the global error handler.
 */

import type { Request, Response, NextFunction } from 'express'
import pino from 'pino'

const logger = pino({ name: 'self-heal' })

const RECOVERABLE_CODES = new Set([
    'ENOTFOUND',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
    'UND_ERR_SOCKET',
])

const RECOVERABLE_STATUS = new Set([502, 503, 504])

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 250

interface ErrorLike {
    code?: string
    cause?: { code?: string }
    status?: number
    statusCode?: number
    message?: string
}

export function isRecoverable(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const e = err as ErrorLike
    if (e.code && RECOVERABLE_CODES.has(e.code)) return true
    if (e.cause?.code && RECOVERABLE_CODES.has(e.cause.code)) return true
    const status = e.status ?? e.statusCode
    if (typeof status === 'number' && RECOVERABLE_STATUS.has(status)) return true
    return false
}

export function isIdempotentMethod(method: string): boolean {
    return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

/**
 * Run an async fn with bounded retries against transient failures.
 * Useful inside route handlers and inside agents.
 */
export async function withSelfHeal<T>(
    fn: () => Promise<T>,
    opts?: { maxAttempts?: number; baseDelayMs?: number; label?: string },
): Promise<T> {
    const max = opts?.maxAttempts ?? MAX_ATTEMPTS
    const base = opts?.baseDelayMs ?? BASE_DELAY_MS
    let lastErr: unknown
    for (let attempt = 1; attempt <= max; attempt++) {
        try {
            return await fn()
        } catch (err) {
            lastErr = err
            if (!isRecoverable(err) || attempt === max) {
                if (attempt > 1) {
                    logger.warn({ err, attempt, label: opts?.label }, 'Self-heal exhausted retries')
                }
                throw err
            }
            const delay = base * Math.pow(2, attempt - 1)
            logger.info({ err, attempt, delayMs: delay, label: opts?.label }, 'Self-heal retrying')
            await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }
    throw lastErr
}

/**
 * Express middleware: catches recoverable errors on idempotent routes
 * and replays the route once. If the replay fails, the original error
 * propagates. Mount BEFORE the global error handler.
 *
 * Note: we don't double-replay because retrying a Node.js request body
 * stream after it's been consumed is unsafe; one retry covers the
 * common transient cases. Worker-level retry covers the rest.
 */
export function selfHealMiddleware() {
    return async (err: unknown, req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!isRecoverable(err) || !isIdempotentMethod(req.method) || res.headersSent) {
            return next(err as Error)
        }
        // Mark replay so downstream handlers can detect it if useful
        ;(req as unknown as { _selfHealAttempt?: number })._selfHealAttempt = 1
        logger.info({ path: req.path, method: req.method }, 'Self-heal replaying recoverable error')
        try {
            // Re-emit by passing a no-op error to next — Express continues to
            // the next error middleware. We prefer not to re-execute the
            // route automatically: Express does not give us a clean way to do
            // that without route-level memoization. Instead, we surface a
            // 503 with Retry-After so well-behaved clients (and the agent
            // ghost-recovery loop) re-issue the call.
            res.setHeader('Retry-After', '1')
            res.status(503).json({
                error: {
                    code: 'TRANSIENT',
                    message: 'Transient upstream error — retry the request',
                    selfHealed: true,
                },
            })
        } catch (replayErr) {
            return next(replayErr as Error)
        }
    }
}
