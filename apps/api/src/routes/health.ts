// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import pkg from '../../package.json' with { type: 'json' }
import { db, sql, eq, and, isNull } from '@plexo/db'
import { workspaces, extensionPrompts, extensionContexts } from '@plexo/db'
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
 * Tracks consecutive auth failures per workspace+provider to suppress log spam.
 * After AUTH_FAIL_WARN_THRESHOLD consecutive 401/403 failures, the log level
 * is downgraded from WARN to DEBUG — stale keys won't pollute logs forever.
 * Counter resets on any successful ping.
 */
const authFailCounts = new Map<string, number>()
const AUTH_FAIL_WARN_THRESHOLD = 3

function isAuthError(status: number): boolean {
    return status === 401 || status === 403
}

/**
 * Probes the configured primary AI provider using a real API call.
 * Returns ok=null when no provider is configured (not a failure — just unconfigured).
 */
async function pingAIProvider(): Promise<{ ok: boolean | null; latencyMs: number; error?: string; provider?: string }> {
    let providerKey: string | undefined
    let apiKey: string | undefined
    let baseUrl: string | undefined
    let workspaceId: string | undefined

    try {
        const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(5)
        for (const row of rows) {
            const ap = await loadDecryptedAIProviders(row.id)
            if (!ap) continue
            const primary = ap.primary ?? ap.primaryProvider
            if (!primary) continue
            const p = ap.providers?.[primary]
            if (p?.apiKey && p.apiKey !== 'placeholder') {
                workspaceId = row.id
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

    const failKey = `${workspaceId}:${providerKey}`
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
            // Parse error type/code only — never log the raw body as provider
            // error messages (e.g. OpenAI 401) can contain partial API keys.
            let safeDetail: string | undefined
            try {
                const parsed = JSON.parse(body)
                const err = parsed?.error
                safeDetail = err?.type ?? err?.code ?? err?.status ?? undefined
            } catch { safeDetail = undefined }

            // Downgrade persistent auth errors (stale keys) to DEBUG after threshold
            if (isAuthError(res.status)) {
                const count = (authFailCounts.get(failKey) ?? 0) + 1
                authFailCounts.set(failKey, count)
                const logFn = count >= AUTH_FAIL_WARN_THRESHOLD ? logger.debug : logger.warn
                logFn.call(logger, { status: res.status, errorType: safeDetail, providerKey, consecutiveAuthFails: count }, 'AI provider ping non-ok')
            } else {
                // Transient errors (5xx, 429, etc.) always warn — they may resolve
                logger.warn({ status: res.status, errorType: safeDetail, providerKey }, 'AI provider ping non-ok')
            }
            return { ok: false, latencyMs: Date.now() - start, error: `http_${res.status}`, provider: providerKey }
        }
        // Success — reset auth failure counter
        authFailCounts.delete(failKey)
        return { ok: true, latencyMs: Date.now() - start, provider: providerKey }
    } catch (err) {
        logger.warn({ err, providerKey }, 'AI provider ping failed')
        return { ok: false, latencyMs: Date.now() - start, error: 'network_error', provider: providerKey }
    }
}


healthRouter.get('/', async (req, res) => {
    const [postgres, redis, aiProvider] = await Promise.allSettled([
        pingPostgres(),
        pingRedis(),
        pingAIProvider(),
    ])

    const pgResult = postgres.status === 'fulfilled' ? postgres.value : { ok: false, latencyMs: 0 }
    const redisResult = redis.status === 'fulfilled' ? redis.value : { ok: false, latencyMs: 0 }
    const aiResult = aiProvider.status === 'fulfilled' ? aiProvider.value : { ok: false, latencyMs: 0 }

    // Degraded if DB or Redis is down (structural deps)
    // AI provider down is tolerated — may not be configured yet
    const critical = pgResult.ok && redisResult.ok
    const status = critical ? 'ok' : 'degraded'

    // Public response: minimal — just status and service availability booleans.
    // Internal details (latencies, versions, worker stats, DB counts) are only
    // returned when the caller provides a valid debug token or Supabase JWT.
    const hasDebugToken = process.env.DEBUG_TOKEN && req.headers['x-debug-token'] === process.env.DEBUG_TOKEN
    const hasAuth = !!req.headers.authorization?.startsWith('Bearer ')

    const publicResponse: Record<string, unknown> = {
        status,
        services: {
            postgres: { ok: pgResult.ok },
            redis: { ok: redisResult.ok },
            ai: { ok: aiResult.ok },
        },
    }

    if (hasDebugToken || hasAuth) {
        // Privileged caller — include full diagnostics
        const services = {
            postgres: pgResult,
            redis: redisResult,
            ai: aiResult,
        }

        // Fabric §7.6/§7.7 status — lightweight aggregate counts
        let promptLibrary = { totalPrompts: 0, enabledPrompts: 0 }
        let contextLayer = { totalContexts: 0, enabledContexts: 0 }
        try {
            const [pTotal] = await db.select({ count: sql<number>`count(*)` }).from(extensionPrompts).where(isNull(extensionPrompts.deletedAt))
            const [pEnabled] = await db.select({ count: sql<number>`count(*)` }).from(extensionPrompts).where(and(eq(extensionPrompts.enabled, true), isNull(extensionPrompts.deletedAt)))
            promptLibrary = { totalPrompts: Number(pTotal?.count ?? 0), enabledPrompts: Number(pEnabled?.count ?? 0) }
        } catch { /* non-fatal */ }
        try {
            const [cTotal] = await db.select({ count: sql<number>`count(*)` }).from(extensionContexts).where(isNull(extensionContexts.deletedAt))
            const [cEnabled] = await db.select({ count: sql<number>`count(*)` }).from(extensionContexts).where(and(eq(extensionContexts.enabled, true), isNull(extensionContexts.deletedAt)))
            contextLayer = { totalContexts: Number(cTotal?.count ?? 0), enabledContexts: Number(cEnabled?.count ?? 0) }
        } catch { /* non-fatal */ }

        publicResponse.services = services
        publicResponse.version = pkg.version ?? '0.1.0'
        publicResponse.uptime = Math.floor(process.uptime())
        publicResponse.fabric = {
            complianceLevel: 'full',
            specVersion: '0.4.0',
            host: 'plexo',
            workers: workerStats(),
            promptLibrary,
            contextLayer,
        }
    }

    res.status(critical ? 200 : 503).json(publicResponse)
})
