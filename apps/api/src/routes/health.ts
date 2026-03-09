import { Router, type Router as RouterType } from 'express'
import pkg from '../../package.json' with { type: 'json' }
import { db, sql, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import { createClient } from 'redis'
import { logger } from '../logger.js'
import { workerStats } from '@plexo/agent/persistent-pool'
import { loadDecryptedAIProviders } from './ai-provider-creds.js'

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

/**
 * Probes the configured primary AI provider using a real API call.
 * Returns ok=null when no provider is configured (not a failure — just unconfigured).
 */
async function pingAIProvider(): Promise<{ ok: boolean | null; latencyMs: number; error?: string; provider?: string }> {
    let providerKey: string | undefined
    let apiKey: string | undefined
    let baseUrl: string | undefined

    try {
        const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(5)
        for (const row of rows) {
            const ap = await loadDecryptedAIProviders(row.id)
            if (!ap) continue
            const primary = ap.primary ?? ap.primaryProvider
            if (!primary) continue
            const p = ap.providers?.[primary]
            if (p?.apiKey && p.apiKey !== 'placeholder') {
                providerKey = primary
                apiKey = p.apiKey
                baseUrl = p.baseUrl
                break
            }
        }
    } catch { /* non-fatal */ }

    if (!providerKey || !apiKey) {
        return { ok: null, latencyMs: 0, error: 'not_configured' }
    }

    const start = Date.now()
    const MODELS_ENDPOINTS: Record<string, string> = {
        anthropic: 'https://api.anthropic.com/v1/models',
        openai: 'https://api.openai.com/v1/models',
        openrouter: 'https://openrouter.ai/api/v1/models',
        groq: 'https://api.groq.com/openai/v1/models',
        google: 'https://generativelanguage.googleapis.com/v1/models',
    }
    const url = baseUrl ? `${baseUrl}/models` : MODELS_ENDPOINTS[providerKey]
    if (!url) return { ok: null, latencyMs: 0, error: 'not_configured', provider: providerKey }

    try {
        const headers: Record<string, string> = providerKey === 'anthropic'
            ? { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey }
            : { 'Authorization': `Bearer ${apiKey}` }

        const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            logger.warn({ status: res.status, body: body.slice(0, 200), providerKey }, 'AI provider ping non-ok')
            return { ok: false, latencyMs: Date.now() - start, error: `http_${res.status}`, provider: providerKey }
        }
        return { ok: true, latencyMs: Date.now() - start, provider: providerKey }
    } catch (err) {
        logger.warn({ err, providerKey }, 'AI provider ping failed')
        return { ok: false, latencyMs: Date.now() - start, error: 'network_error', provider: providerKey }
    }
}


healthRouter.get('/', async (_req, res) => {
    const [postgres, redis, aiProvider] = await Promise.allSettled([
        pingPostgres(),
        pingRedis(),
        pingAIProvider(),
    ])

    const services = {
        postgres: postgres.status === 'fulfilled' ? postgres.value : { ok: false, latencyMs: 0 },
        redis: redis.status === 'fulfilled' ? redis.value : { ok: false, latencyMs: 0 },
        ai: aiProvider.status === 'fulfilled' ? aiProvider.value : { ok: false, latencyMs: 0 },
    }

    // Degraded if DB or Redis is down (structural deps)
    // AI provider down is tolerated — may not be configured yet
    const critical = services.postgres.ok && services.redis.ok
    const status = critical ? 'ok' : 'degraded'

    res.status(critical ? 200 : 503).json({
        status,
        services,
        version: pkg.version ?? '0.1.0',
        uptime: Math.floor(process.uptime()),
        kapsel: {
            complianceLevel: 'full',
            specVersion: '0.2.0',
            host: 'plexo',
            workers: workerStats(),
        },
    })
})
