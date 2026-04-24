// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Rate limiting middleware — Redis-backed (SEC-042)
 *
 * Tiers:
 * - General API: 2000 req / 15 min per IP
 * - Auth endpoints: 10 req / 1 min per IP (brute-force protection)
 * - Task creation: 60 req / 15 min per IP (cost protection)
 * - Webhooks: 100 req / 1 min per IP (public endpoints, HMAC-verified)
 *
 * Uses Redis via rate-limit-redis for consistency across restarts.
 * Falls back gracefully if Redis is unavailable (express-rate-limit default in-memory).
 */
import { rateLimit } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { getRedis, isRedisAvailable, markRedisDown } from '../redis-client.js'

const WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const MINUTE_MS = 60 * 1000

const isLoopback = (ip: string | undefined) =>
    ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

// OPS-003: Rate-limit store degrades to in-memory when Redis circuit is open.
// The RedisStore.sendCommand wrapper checks the breaker before each call.
function makeStore(prefix: string): RedisStore {
    return new RedisStore({
        sendCommand: async (...args: string[]) => {
            if (!isRedisAvailable()) throw new Error('Redis circuit open')
            try {
                const c = await getRedis()
                return c.sendCommand(args)
            } catch (err) {
                markRedisDown()
                throw err
            }
        },
        prefix: `rl:${prefix}:`,
    })
}

export const generalLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: 2000,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: makeStore('gen'),
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests — try again later' } },
    skip: (req) => req.path === '/health' || isLoopback(req.ip),
})

export const authLimiter = rateLimit({
    windowMs: MINUTE_MS,
    max: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: makeStore('auth'),
    message: { error: { code: 'AUTH_RATE_LIMITED', message: 'Too many auth attempts — try again in a minute' } },
    skip: (req) => isLoopback(req.ip),
})

export const taskCreationLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: makeStore('task'),
    message: { error: { code: 'TASK_RATE_LIMITED', message: 'Task creation limit reached — try again later' } },
    skip: (req) => isLoopback(req.ip),
})

export const webhookLimiter = rateLimit({
    windowMs: MINUTE_MS,
    max: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: makeStore('wh'),
    message: { error: { code: 'WEBHOOK_RATE_LIMITED', message: 'Webhook rate limit exceeded' } },
    skip: (req) => isLoopback(req.ip),
})
