// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Redis client singleton — shared across API modules.
 *
 * Pattern matches pkce-store.ts. Connect once, reuse everywhere.
 *
 * OPS-003: Circuit breaker prevents cascading 500s when Redis is down.
 * Non-critical consumers (rate-limit, cache reads, SSE ack) should check
 * `isRedisAvailable()` before calling `getRedis()`. Critical consumers
 * (queue, OWD) call `getRedis()` directly and let errors propagate.
 */
import { createClient, type RedisClientType } from 'redis'
import pino from 'pino'

const logger = pino({ name: 'redis-client' })

let _redis: RedisClientType | null = null
let connecting = false

// ── OPS-003: Circuit breaker state ───────────────────────────────
let _redisDown = false
let _redisDownUntil = 0
const CIRCUIT_OPEN_DURATION_MS = 30_000

/** Check if Redis is believed to be available. Resets after 30s cooldown. */
export function isRedisAvailable(): boolean {
    if (_redisDown && Date.now() > _redisDownUntil) {
        _redisDown = false
        logger.info('Redis circuit breaker reset — will retry on next call')
    }
    return !_redisDown
}

/** Mark Redis as down. Non-critical callers skip Redis for `durationMs`. */
export function markRedisDown(durationMs = CIRCUIT_OPEN_DURATION_MS): void {
    if (!_redisDown) {
        logger.warn({ durationMs }, 'Redis circuit breaker OPEN — non-critical ops will use fallbacks')
    }
    _redisDown = true
    _redisDownUntil = Date.now() + durationMs
}

export async function getRedis(): Promise<RedisClientType> {
    if (_redis?.isReady) return _redis

    if (connecting) {
        // Wait up to 3s for the in-progress connect
        const start = Date.now()
        while (connecting && Date.now() - start < 3000) {
            await new Promise((r) => setTimeout(r, 50))
        }
        if (_redis?.isReady) return _redis
        throw new Error('Redis connection timed out')
    }

    connecting = true
    try {
        _redis = createClient({
            url: process.env.REDIS_URL ?? 'redis://localhost:6379',
        }) as RedisClientType

        _redis.on('error', (err: Error) => {
            logger.error({ err }, 'Redis client error')
            markRedisDown()
        })

        await _redis.connect()
        _redisDown = false // successful connect clears the breaker
        logger.info('Redis connected')
        return _redis
    } catch (err) {
        markRedisDown()
        throw err
    } finally {
        connecting = false
    }
}
