// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Analytics client — anonymous crash reporting.
 *
 * Errors are relayed to the native Command Engine analytics ingest
 * (or a self-hosted Command Center instance) via ANALYTICS_RELAY_URL.
 * All payloads are sanitized before leaving this process.
 */
import { createClient as createRedis, type RedisClientType } from 'redis'
import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { sanitize, type RawErrorContext, type AnalyticsError } from './sanitize.js'

const logger = pino({ name: 'analytics' })

// In-memory config — loaded from workspace settings on init
let _errorsEnabled = false
let _usageEnabled = false
let _instanceId: string = randomUUID()
let _plexoVersion = '0.1.0'
let _redis: RedisClientType | null = null

export function configureAnalytics(opts: {
    enabled?: boolean       // Legacy single toggle (backwards compat)
    errorsEnabled?: boolean
    usageEnabled?: boolean
    instanceId: string
    plexoVersion: string
    redisUrl?: string
}): void {
    // Support both legacy single toggle and new split toggles
    if (opts.errorsEnabled !== undefined) _errorsEnabled = opts.errorsEnabled
    else if (opts.enabled !== undefined) _errorsEnabled = opts.enabled
    if (opts.usageEnabled !== undefined) _usageEnabled = opts.usageEnabled
    else if (opts.enabled !== undefined) _usageEnabled = opts.enabled
    _instanceId = opts.instanceId
    _plexoVersion = opts.plexoVersion

    if (opts.redisUrl && !_redis) {
        _redis = createRedis({ url: opts.redisUrl }) as RedisClientType
        void _redis.connect().catch(() => { /* redis optional for analytics */ })
    }

    logger.info({
        errorsEnabled: _errorsEnabled,
        usageEnabled: _usageEnabled,
        instanceId: _instanceId.slice(0, 8) + '...',
    }, 'Analytics configured')
}

/** Legacy getter — returns true if either channel is enabled (for backwards compat) */
export function getAnalyticsConfig(): { enabled: boolean; instanceId: string } {
    return { enabled: _errorsEnabled || _usageEnabled, instanceId: _instanceId }
}

/** Granular getters for the two channels */
export function isErrorsEnabled(): boolean { return _errorsEnabled }
export function isUsageEnabled(): boolean { return _usageEnabled }

/** Legacy setter — sets both channels (backwards compat) */
export function setAnalyticsEnabled(enabled: boolean): void {
    _errorsEnabled = enabled
    _usageEnabled = enabled
}

/** Granular setters */
export function setErrorsEnabled(enabled: boolean): void { _errorsEnabled = enabled }
export function setUsageEnabled(enabled: boolean): void { _usageEnabled = enabled }

/**
 * Load analytics consent from the database at startup.
 * Resolves the init race condition where _enabled was hardcoded to false.
 */
export async function syncAnalyticsFromDB(): Promise<void> {
    try {
        const { db, sql } = await import('@plexo/db')
        // Load from first workspace — analytics is instance-level but stored per-workspace
        const rows = await db.execute<{ settings: Record<string, unknown> }>(sql`
            SELECT settings FROM workspaces ORDER BY created_at ASC LIMIT 1
        `)
        const settings = rows[0]?.settings as Record<string, unknown> | undefined
        const analytics = (settings?.analytics ?? settings?.telemetry) as Record<string, unknown> | undefined
        if (!analytics) {
            logger.info('Analytics: no consent found in DB — defaults remain (both disabled)')
            return
        }

        // Support both legacy single 'enabled' and new split toggles
        if (typeof analytics.errors_enabled === 'boolean') _errorsEnabled = analytics.errors_enabled
        else if (typeof analytics.enabled === 'boolean') _errorsEnabled = analytics.enabled
        if (typeof analytics.usage_enabled === 'boolean') _usageEnabled = analytics.usage_enabled
        else if (typeof analytics.enabled === 'boolean') _usageEnabled = analytics.enabled

        if (typeof analytics.instance_id === 'string' && analytics.instance_id.length > 10) {
            _instanceId = analytics.instance_id
        }

        logger.info({
            errorsEnabled: _errorsEnabled,
            usageEnabled: _usageEnabled,
            instanceId: _instanceId.slice(0, 8) + '...',
            source: 'db',
        }, 'Analytics consent synced from database at startup')
    } catch (err) {
        logger.warn({ err }, 'Failed to sync analytics from DB — defaults remain (both disabled)')
    }
}

/**
 * Capture a sanitized error event.
 * Always stores the last payload in Redis (for "view last report" UI).
 * Only POSTs to the relay if analytics is enabled.
 */
export async function captureError(ctx: Omit<RawErrorContext, 'instanceId' | 'plexoVersion'>): Promise<void> {
    const payload = sanitize({ ...ctx, instanceId: _instanceId, plexoVersion: _plexoVersion })

    // Always store last payload — shown in UI whether enabled or not
    await storeLastPayload(payload)

    if (!_errorsEnabled) return

    // Relay to native Command Engine analytics ingest
    const { relayError } = await import('./relay.js')
    void relayError({
        fingerprint: `${payload.errorType}:${payload.stackFrames[0] ?? 'unknown'}`,
        message: payload.errorType,
        stack_trace: payload.stackFrames.join('\n'),
        context: {
            pipelineStep: payload.pipelineStep,
            taskCategory: payload.taskCategory,
            pluginName: payload.pluginName,
            plexoVersion: payload.plexoVersion,
            nodeVersion: payload.nodeVersion,
        },
    }, _instanceId)
}

async function storeLastPayload(payload: AnalyticsError): Promise<void> {
    if (!_redis) return
    try {
        const key = `analytics:last_payload:${_instanceId}`
        await _redis.set(key, JSON.stringify(payload, null, 2), { EX: 60 * 60 * 24 * 30 }) // 30d
    } catch {
        // Non-fatal
    }
}

export async function getLastPayload(): Promise<AnalyticsError | null> {
    if (!_redis) return null
    try {
        const key = `analytics:last_payload:${_instanceId}`
        const raw = await _redis.get(key)
        return raw ? JSON.parse(raw) as AnalyticsError : null
    } catch {
        return null
    }
}
