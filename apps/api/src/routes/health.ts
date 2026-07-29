// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { timingSafeEqual } from 'node:crypto'
import pkg from '../../package.json' with { type: 'json' }
import * as healthRepo from '../repositories/health.repository.js'
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
        await healthRepo.pingDb()
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
 * Probe the bundled embeddings server (ONNX embeddings service). Returns
 * ok=null when no embeddings URL is configured — embeddings are optional
 * for self-hosters who don't use memory search.
 *
 * Reads EMBEDDINGS_URL first; falls back to the deprecated
 * INFERENCE_GATEWAY_URL for one release so existing .env files keep working.
 */
async function pingEmbeddings(): Promise<{ ok: boolean | null; latencyMs: number; error?: string }> {
    const url = process.env.EMBEDDINGS_URL ?? process.env.INFERENCE_GATEWAY_URL ?? process.env.EMBEDDING_BASE_URL
    if (!url) {
        return { ok: null, latencyMs: 0, error: 'not_configured' }
    }
    const start = Date.now()
    try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) {
            return { ok: false, latencyMs: Date.now() - start, error: `http_${res.status}` }
        }
        return { ok: true, latencyMs: Date.now() - start }
    } catch {
        return { ok: false, latencyMs: Date.now() - start, error: 'network_error' }
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
const AUTH_FAIL_MAP_MAX = 100

// Evict oldest entries when the map grows beyond AUTH_FAIL_MAP_MAX to prevent unbounded growth
function trackAuthFail(key: string): number {
    const count = (authFailCounts.get(key) ?? 0) + 1
    authFailCounts.set(key, count)
    if (authFailCounts.size > AUTH_FAIL_MAP_MAX) {
        // Delete oldest entry (first key in iteration order)
        const firstKey = authFailCounts.keys().next().value
        if (firstKey !== undefined) authFailCounts.delete(firstKey)
    }
    return count
}

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
        const rows = await healthRepo.listWorkspaceIdsSample(5)
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
                const count = trackAuthFail(failKey)
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
    const [postgres, redis, aiProvider, embeddings] = await Promise.allSettled([
        pingPostgres(),
        pingRedis(),
        pingAIProvider(),
        pingEmbeddings(),
    ])

    const pgResult = postgres.status === 'fulfilled' ? postgres.value : { ok: false, latencyMs: 0 }
    const redisResult = redis.status === 'fulfilled' ? redis.value : { ok: false, latencyMs: 0 }
    const aiResult = aiProvider.status === 'fulfilled' ? aiProvider.value : { ok: false, latencyMs: 0 }
    const embeddingsResult = embeddings.status === 'fulfilled' ? embeddings.value : { ok: false, latencyMs: 0 }

    // Feed gauges back to the metrics collector so /metrics reflects the
    // latest probe without needing to re-run the checks. Embeddings returns
    // null when unconfigured — treat null as "n/a" (1 = up for now).
    try {
        const { setGauge } = await import('../lib/metrics.js')
        setGauge('plexo_db_up', pgResult.ok ? 1 : 0)
        setGauge('plexo_redis_up', redisResult.ok ? 1 : 0)
        setGauge('plexo_embeddings_up', embeddingsResult.ok === false ? 0 : 1)
    } catch { /* non-fatal */ }

    // Degraded if DB or Redis is down (structural deps)
    // AI provider down is tolerated — may not be configured yet
    const critical = pgResult.ok && redisResult.ok
    const status = critical ? 'ok' : 'degraded'

    // Public response: minimal — just status and service availability booleans.
    // Internal details (latencies, versions, worker stats, DB counts) are only
    // returned when the caller provides a valid debug token or auth session.
    const hasDebugToken = (() => {
        const expected = process.env.DEBUG_TOKEN
        const provided = req.headers['x-debug-token']
        if (!expected || typeof provided !== 'string') return false
        try {
            const a = Buffer.from(expected)
            const b = Buffer.from(provided)
            return a.length === b.length && timingSafeEqual(a, b)
        } catch { return false }
    })()
    const hasAuth = !!req.headers.authorization?.startsWith('Bearer ')

    // Count registered app profiles (lightweight, cached per request)
    let registeredProfiles = 0
    try {
        const row = await healthRepo.getRegisteredProfileCount()
        registeredProfiles = Number(row?.count ?? 0)
    } catch { /* non-fatal */ }

    const publicResponse: Record<string, unknown> = {
        status,
        version: pkg.version ?? '0.1.0',
        uptime: Math.floor(process.uptime()),
        services: {
            postgres: { ok: pgResult.ok },
            redis: { ok: redisResult.ok },
            ai: { ok: aiResult.ok },
            embeddings: { ok: embeddingsResult.ok },
        },
        registeredProfiles,
    }

    if (hasDebugToken || hasAuth) {
        // Privileged caller — include full diagnostics
        const services = {
            postgres: pgResult,
            redis: redisResult,
            ai: aiResult,
            embeddings: embeddingsResult,
        }

        // PEX §7.6/§7.7 status — lightweight aggregate counts (all 4 queries run in parallel)
        let promptLibrary = { totalPrompts: 0, enabledPrompts: 0 }
        let contextLayer = { totalContexts: 0, enabledContexts: 0 }
        try {
            const [[pTotal], [pEnabled], [cTotal], [cEnabled]] = await healthRepo.getPexCounts()
            promptLibrary = { totalPrompts: Number(pTotal?.count ?? 0), enabledPrompts: Number(pEnabled?.count ?? 0) }
            contextLayer = { totalContexts: Number(cTotal?.count ?? 0), enabledContexts: Number(cEnabled?.count ?? 0) }
        } catch { /* non-fatal */ }

        publicResponse.services = services
        publicResponse.version = pkg.version ?? '0.1.0'
        publicResponse.uptime = Math.floor(process.uptime())
        publicResponse.pex = {
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
