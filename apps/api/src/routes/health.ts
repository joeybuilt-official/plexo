import { Router, type Router as RouterType } from 'express'
import { db, sql } from '@plexo/db'
import { createClient } from 'redis'
import { logger } from '../logger.js'

export const healthRouter: RouterType = Router()

// Lazy Redis client — reused across health checks
let redisClient: ReturnType<typeof createClient> | null = null
async function getRedis() {
    if (!redisClient) {
        redisClient = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
        redisClient.on('error', (err: Error) => logger.warn({ err }, 'Redis health check error'))
        await redisClient.connect()
    }
    return redisClient
}

async function pingPostgres(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now()
    try {
        await db.execute(sql`SELECT 1`)
        return { ok: true, latencyMs: Date.now() - start }
    } catch {
        return { ok: false, latencyMs: Date.now() - start }
    }
}

async function pingRedis(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now()
    try {
        const client = await getRedis()
        await client.ping()
        return { ok: true, latencyMs: Date.now() - start }
    } catch {
        return { ok: false, latencyMs: Date.now() - start }
    }
}

async function pingAnthropic(): Promise<{ ok: boolean; latencyMs: number }> {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key || key === 'placeholder') {
        return { ok: false, latencyMs: 0 }
    }
    const start = Date.now()
    try {
        const res = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
            },
            signal: AbortSignal.timeout(5000),
        })
        return { ok: res.ok, latencyMs: Date.now() - start }
    } catch {
        return { ok: false, latencyMs: Date.now() - start }
    }
}

healthRouter.get('/', async (_req, res) => {
    const [postgres, redis, anthropic] = await Promise.allSettled([
        pingPostgres(),
        pingRedis(),
        pingAnthropic(),
    ])

    const services = {
        postgres: postgres.status === 'fulfilled' ? postgres.value : { ok: false, latencyMs: 0 },
        redis: redis.status === 'fulfilled' ? redis.value : { ok: false, latencyMs: 0 },
        anthropic: anthropic.status === 'fulfilled' ? anthropic.value : { ok: false, latencyMs: 0 },
    }

    // Degraded if DB or Redis is down (structural deps)
    // Anthropic down is tolerated — may be using OAuth or key not configured yet
    const critical = services.postgres.ok && services.redis.ok
    const status = critical ? 'ok' : 'degraded'

    res.status(critical ? 200 : 503).json({
        status,
        services,
        version: process.env.npm_package_version ?? '0.1.0',
        uptime: Math.floor(process.uptime()),
    })
})
