// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PostHog client — anonymous crash reporting.
 *
 * Events are forwarded through a keyless relay at posthog.getplexo.com/ingest.
 * The relay injects the PostHog API key server-side — no key is ever in this source.
 * PostHog is self-hosted on Plexo infrastructure; no data touches PostHog cloud.
 * The client is a no-op when telemetry is disabled.
 */
import { createClient as createRedis, type RedisClientType } from 'redis'
import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { sanitize, type RawErrorContext, type TelemetryError } from './sanitize.js'

const logger = pino({ name: 'telemetry' })

// Points at the keyless relay — no API key in this codebase.
const TELEMETRY_INGEST = `${process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://posthog.getplexo.com'}/ingest`

// In-memory config — loaded from workspace settings on init
let _errorsEnabled = false
let _usageEnabled = false
let _instanceId: string = randomUUID()
let _plexoVersion = '0.1.0'
let _redis: RedisClientType | null = null

export function configureTelemetry(opts: {
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
        void _redis.connect().catch(() => { /* redis optional for telemetry */ })
    }

    logger.info({
        errorsEnabled: _errorsEnabled,
        usageEnabled: _usageEnabled,
        instanceId: _instanceId.slice(0, 8) + '...',
    }, 'Telemetry configured')
}

/** Legacy getter — returns true if either channel is enabled (for backwards compat) */
export function getTelemetryConfig(): { enabled: boolean; instanceId: string } {
    return { enabled: _errorsEnabled || _usageEnabled, instanceId: _instanceId }
}

/** Granular getters for the two channels */
export function isErrorsEnabled(): boolean { return _errorsEnabled }
export function isUsageEnabled(): boolean { return _usageEnabled }

/** Legacy setter — sets both channels (backwards compat) */
export function setTelemetryEnabled(enabled: boolean): void {
    _errorsEnabled = enabled
    _usageEnabled = enabled
}

/** Granular setters */
export function setErrorsEnabled(enabled: boolean): void { _errorsEnabled = enabled }
export function setUsageEnabled(enabled: boolean): void { _usageEnabled = enabled }

/**
 * Load telemetry consent from the database at startup.
 * Resolves the init race condition where _enabled was hardcoded to false.
 */
export async function syncTelemetryFromDB(): Promise<void> {
    try {
        const { db, sql } = await import('@plexo/db')
        // Load from first workspace — telemetry is instance-level but stored per-workspace
        const rows = await db.execute<{ settings: Record<string, unknown> }>(sql`
            SELECT settings FROM workspaces ORDER BY created_at ASC LIMIT 1
        `)
        const settings = rows[0]?.settings as Record<string, unknown> | undefined
        const telemetry = settings?.telemetry as Record<string, unknown> | undefined
        if (!telemetry) {
            logger.info('Telemetry: no consent found in DB — defaults remain (both disabled)')
            return
        }

        // Support both legacy single 'enabled' and new split toggles
        if (typeof telemetry.errors_enabled === 'boolean') _errorsEnabled = telemetry.errors_enabled
        else if (typeof telemetry.enabled === 'boolean') _errorsEnabled = telemetry.enabled
        if (typeof telemetry.usage_enabled === 'boolean') _usageEnabled = telemetry.usage_enabled
        else if (typeof telemetry.enabled === 'boolean') _usageEnabled = telemetry.enabled

        if (typeof telemetry.instance_id === 'string' && telemetry.instance_id.length > 10) {
            _instanceId = telemetry.instance_id
        }

        logger.info({
            errorsEnabled: _errorsEnabled,
            usageEnabled: _usageEnabled,
            instanceId: _instanceId.slice(0, 8) + '...',
            source: 'db',
        }, 'Telemetry consent synced from database at startup')
    } catch (err) {
        logger.warn({ err }, 'Failed to sync telemetry from DB — defaults remain (both disabled)')
    }
}

/**
 * Capture a sanitized error event.
 * Always stores the last payload in Redis (for "view last report" UI).
 * Only POSTs to the relay if telemetry is enabled.
 */
export async function captureError(ctx: Omit<RawErrorContext, 'instanceId' | 'plexoVersion'>): Promise<void> {
    const payload = sanitize({ ...ctx, instanceId: _instanceId, plexoVersion: _plexoVersion })

    // Always store last payload — shown in UI whether enabled or not
    await storeLastPayload(payload)

    if (!_errorsEnabled) return

    try {
        await fetch(TELEMETRY_INGEST, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                event: 'crash',
                distinct_id: _instanceId,
                properties: payload,
                timestamp: new Date().toISOString(),
                // no api_key — relay injects it server-side
            }),
            signal: AbortSignal.timeout(5000), // never block the process
        })
    } catch (err) {
        logger.debug({ err }, 'Telemetry POST failed — suppressed')
    }
}

async function storeLastPayload(payload: TelemetryError): Promise<void> {
    if (!_redis) return
    try {
        const key = `telemetry:last_payload:${_instanceId}`
        await _redis.set(key, JSON.stringify(payload, null, 2), { EX: 60 * 60 * 24 * 30 }) // 30d
    } catch {
        // Non-fatal
    }
}

export async function getLastPayload(): Promise<TelemetryError | null> {
    if (!_redis) return null
    try {
        const key = `telemetry:last_payload:${_instanceId}`
        const raw = await _redis.get(key)
        return raw ? JSON.parse(raw) as TelemetryError : null
    } catch {
        return null
    }
}
