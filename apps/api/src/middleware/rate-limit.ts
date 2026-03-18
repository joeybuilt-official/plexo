// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Rate limiting middleware
 *
 * Tiers:
 * - General API: 300 req / 15 min per IP
 * - Auth endpoints: 20 req / 15 min per IP (brute-force protection)
 * - Task creation: 60 req / 15 min per IP (cost protection)
 *
 * Uses in-memory store (sufficient for single-instance VPS).
 * For multi-instance: swap to redis store via rate-limit-redis.
 */
import { rateLimit } from 'express-rate-limit'

const WINDOW_MS = 15 * 60 * 1000 // 15 minutes

const isLoopback = (ip: string | undefined) =>
    ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

export const generalLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: 2000,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests — try again later' } },
    skip: (req) => req.path === '/health' || isLoopback(req.ip),
})

export const authLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'AUTH_RATE_LIMITED', message: 'Too many auth attempts — try again in 15 minutes' } },
    skip: (req) => isLoopback(req.ip),
})

export const taskCreationLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'TASK_RATE_LIMITED', message: 'Task creation limit reached — try again later' } },
    skip: (req) => isLoopback(req.ip),
})
