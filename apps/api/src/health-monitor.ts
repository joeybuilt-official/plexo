// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Health monitor — polls services at a fixed interval, detects state
 * transitions (healthy ↔ unhealthy), stores events in Valkey, and
 * sends webhook notifications on transitions.
 *
 * Runs only when HEALTH_MONITOR_ENABLED=true (set in command-engine env).
 * Webhook URL: HEALTH_WEBHOOK_URL (optional).
 */

import { logger } from './logger.js'

const POLL_INTERVAL = 60_000 // 1 minute
const MAX_TIMELINE_ENTRIES = 200
const VALKEY_KEY_STATE = 'health-monitor:state'
const VALKEY_KEY_TIMELINE = 'health-monitor:timeline'

interface MonitoredService {
    id: string
    name: string
    url: string
    endpoint: string
}

interface HealthState {
    [serviceId: string]: {
        status: 'healthy' | 'unhealthy' | 'unknown'
        since: string
        lastCheck: string
        latencyMs?: number
        error?: string
    }
}

export interface HealthEvent {
    serviceId: string
    serviceName: string
    from: 'healthy' | 'unhealthy' | 'unknown'
    to: 'healthy' | 'unhealthy'
    timestamp: string
    latencyMs?: number
    error?: string
}

// Default services to monitor. Override with HEALTH_MONITOR_SERVICES env var
// (JSON array of { id, name, url, endpoint } objects).
const DEFAULT_SERVICES: MonitoredService[] = [
    { id: 'plexo-saas', name: 'Plexo App', url: 'http://plexo-saas:3000', endpoint: '/' },
    { id: 'plexo-api', name: 'Plexo API', url: 'http://plexo-api:3001', endpoint: '/health' },
    { id: 'embeddings', name: 'Embeddings Server', url: 'http://embeddings:3001', endpoint: '/health' },
]

function loadServices(): MonitoredService[] {
    const envServices = process.env.HEALTH_MONITOR_SERVICES
    if (envServices) {
        try { return JSON.parse(envServices) } catch { /* fall through */ }
    }
    return DEFAULT_SERVICES
}

const SERVICES: MonitoredService[] = loadServices()

let redisClient: any = null
let state: HealthState = {}
let _timer: ReturnType<typeof setInterval> | null = null

async function getRedis() {
    if (redisClient) return redisClient
    try {
        const { getRedis: r } = await import('./redis-client.js')
        redisClient = await r()
        return redisClient
    } catch {
        return null
    }
}

async function loadState(): Promise<HealthState> {
    const redis = await getRedis()
    if (!redis) return {}
    try {
        const raw = await redis.get(VALKEY_KEY_STATE)
        return raw ? JSON.parse(raw) : {}
    } catch (err) { logger.warn({ err }, 'health-monitor: failed to load state from Redis'); return {} }
}

async function saveState(s: HealthState) {
    const redis = await getRedis()
    if (!redis) return
    try { await redis.set(VALKEY_KEY_STATE, JSON.stringify(s)) } catch (err) { logger.warn({ err }, 'health-monitor: failed to save state to Redis') }
}

async function appendEvent(event: HealthEvent) {
    const redis = await getRedis()
    if (!redis) return
    try {
        await redis.lPush(VALKEY_KEY_TIMELINE, JSON.stringify(event))
        await redis.lTrim(VALKEY_KEY_TIMELINE, 0, MAX_TIMELINE_ENTRIES - 1)
    } catch (err) { logger.warn({ err }, 'health-monitor: failed to append event to Redis') }
}

async function checkService(svc: MonitoredService): Promise<{ status: 'healthy' | 'unhealthy'; latencyMs: number; error?: string }> {
    const start = Date.now()
    try {
        const res = await fetch(`${svc.url}${svc.endpoint}`, {
            signal: AbortSignal.timeout(5_000),
            headers: { Accept: 'application/json,text/html' },
        })
        return { status: res.ok ? 'healthy' : 'unhealthy', latencyMs: Date.now() - start }
    } catch (err) {
        return {
            status: 'unhealthy',
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : 'Unknown error',
        }
    }
}

async function sendWebhook(event: HealthEvent) {
    const url = process.env.HEALTH_WEBHOOK_URL
    if (!url) return
    try {
        const emoji = event.to === 'unhealthy' ? '🔴' : '🟢'
        const text = `${emoji} **${event.serviceName}** is now **${event.to}**${event.error ? ` — ${event.error}` : ''}`

        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                // Discord/Slack compatible
                content: text,
                text,
                // Structured payload
                event,
            }),
            signal: AbortSignal.timeout(10_000),
        })
        logger.info({ serviceId: event.serviceId, to: event.to }, 'Health webhook sent')
    } catch (err) {
        logger.error({ err }, 'Failed to send health webhook')
    }
}

async function poll() {
    const now = new Date().toISOString()
    const results = await Promise.all(SERVICES.map(async (svc) => {
        const result = await checkService(svc)
        return { svc, ...result }
    }))

    for (const { svc, status, latencyMs, error } of results) {
        const prev = state[svc.id]
        const prevStatus = prev?.status ?? 'unknown'

        // Detect transition
        if (prevStatus !== status) {
            const event: HealthEvent = {
                serviceId: svc.id,
                serviceName: svc.name,
                from: prevStatus,
                to: status,
                timestamp: now,
                latencyMs,
                error,
            }
            logger.warn({ event }, `Health transition: ${svc.name} ${prevStatus} → ${status}`)
            await appendEvent(event)

            // Only send webhook for real transitions (not initial unknown → X)
            if (prevStatus !== 'unknown') {
                await sendWebhook(event)
            }
        }

        state[svc.id] = {
            status,
            since: prevStatus !== status ? now : (prev?.since ?? now),
            lastCheck: now,
            latencyMs,
            error,
        }
    }

    await saveState(state)
}

export async function startHealthMonitor() {
    if (process.env.HEALTH_MONITOR_ENABLED !== 'true') {
        logger.info('Health monitor disabled (set HEALTH_MONITOR_ENABLED=true to enable)')
        return
    }

    logger.info({ interval: POLL_INTERVAL, services: SERVICES.length }, 'Starting health monitor')
    state = await loadState()

    // Initial poll after 10s (let services start)
    setTimeout(async () => {
        await poll()
        _timer = setInterval(poll, POLL_INTERVAL)
    }, 10_000)
}

export async function getHealthTimeline(limit = 50): Promise<HealthEvent[]> {
    const redis = await getRedis()
    if (!redis) return []
    try {
        const raw = await redis.lRange(VALKEY_KEY_TIMELINE, 0, limit - 1)
        return raw.map((r: string) => JSON.parse(r))
    } catch { return [] }
}

export async function getHealthState(): Promise<HealthState> {
    const redis = await getRedis()
    if (redis) {
        try {
            const raw = await redis.get(VALKEY_KEY_STATE)
            if (raw) return JSON.parse(raw)
        } catch { /* fall through */ }
    }
    return state
}
