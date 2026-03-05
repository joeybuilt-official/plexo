import { Router, type Router as RouterType } from 'express'
import pkg from '../../package.json' with { type: 'json' }
import { db, sql, eq, and } from '@plexo/db'
import { workspaces, installedConnections } from '@plexo/db'
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

async function pingAnthropic(): Promise<{ ok: boolean | null; latencyMs: number; error?: string }> {
    // 1. Env var override (direct API key only — not an OAuth token)
    let key = process.env.ANTHROPIC_API_KEY
    if (key === 'placeholder' || key?.startsWith('sk-ant-oat')) key = undefined

    // 2. Workspace settings — look up first workspace's aiProviders (decrypted)
    if (!key) {
        try {
            const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(5)
            for (const row of rows) {
                const ap = await loadDecryptedAIProviders(row.id)
                const anthropic = ap?.providers?.anthropic
                if (anthropic?.oauthToken) { key = anthropic.oauthToken; break }
                if (anthropic?.apiKey && anthropic.apiKey !== 'placeholder') { key = anthropic.apiKey; break }
            }
        } catch { /* non-fatal */ }
    }

    // 3. Installed OAuth connection (active Claude.ai token)
    if (!key) {
        try {
            const found = await db.select({ id: installedConnections.id })
                .from(installedConnections)
                .where(and(
                    eq(installedConnections.registryId, 'anthropic-claude'),
                    eq(installedConnections.status, 'active'),
                ))
                .limit(1)
            // Can't test the token here without decrypting — treat presence as ok
            if (found.length > 0) return { ok: true, latencyMs: 0 }
        } catch (e) { logger.warn({ err: e }, 'Anthropic OAuth token check failed') }
    }

    // Not configured at all — report null so UI shows "—" not "✗"
    if (!key) return { ok: null, latencyMs: 0, error: 'not_configured' }

    const start = Date.now()
    try {
        const isOAuth = key.startsWith('sk-ant-oat')
        const headers: Record<string, string> = {
            'anthropic-version': '2023-06-01',
            ...(isOAuth ? { 'Authorization': `Bearer ${key}` } : { 'x-api-key': key }),
        }
        const res = await fetch('https://api.anthropic.com/v1/models', {
            headers,
            signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            logger.warn({ status: res.status, body: body.slice(0, 200) }, 'Anthropic ping non-ok')
            return { ok: false, latencyMs: Date.now() - start, error: `http_${res.status}` }
        }
        return { ok: true, latencyMs: Date.now() - start }
    } catch (err) {
        logger.warn({ err }, 'Anthropic ping failed')
        return { ok: false, latencyMs: Date.now() - start, error: 'network_error' }
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
