// SPDX-License-Identifier: MIT
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
    // Service-key routes (/api/inference, /api/v1/events) are exempt from the
    // coarse per-IP general limit — high-volume internal callers (graphiti,
    // Fonto) share one container IP and would be wrongly throttled. They get
    // the app-id-keyed serviceLimiter instead (Round-5 Phase 2).
    skip: (req) =>
        req.path === '/health'
        || isLoopback(req.ip)
        || req.path.startsWith('/api/inference')
        || req.path.startsWith('/api/v1/events'),
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

// Round-5 Phase 2: backpressure for service-key routes (inference proxy +
// node-events emit). These are the highest-cost ops and had NO HTTP rate limit,
// so a runaway caller (e.g. a Fonto re-enqueue loop) or a leaked key could spam
// LLM calls / event inserts unbounded. Keyed by X-App-Id (callers are separate
// containers, not loopback, so IP keying would lump all apps together) with an
// IP fallback. Generous + env-tunable so legit graphiti/Fonto rates pass and a
// true runaway is still capped. PLEXO_SERVICE_RATE_MAX per app-id per minute
// (default 1200 = 20/s; 0 disables).
const SERVICE_RATE_MAX = Number(process.env.PLEXO_SERVICE_RATE_MAX ?? 1200)
export const serviceLimiter = rateLimit({
    windowMs: MINUTE_MS,
    max: SERVICE_RATE_MAX > 0 ? SERVICE_RATE_MAX : Number.MAX_SAFE_INTEGER,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: makeStore('svc'),
    message: { error: { code: 'SERVICE_RATE_LIMITED', message: 'Service call rate limit exceeded' } },
    keyGenerator: (req) => {
        const appId = req.headers['x-app-id']
        if (typeof appId === 'string' && appId.trim() !== '') return `app:${appId.trim()}`
        return `ip:${req.ip ?? 'unknown'}`
    },
    skip: (req) => isLoopback(req.ip),
})
