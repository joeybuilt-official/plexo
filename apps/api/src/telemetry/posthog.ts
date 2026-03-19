// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PostHog client — anonymous crash reporting.
 *
 * Events are forwarded through a keyless relay at telemetry.getplexo.com/ingest.
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
const TELEMETRY_INGEST = `${process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://telemetry.getplexo.com'}/ingest`

// In-memory config — loaded from workspace settings on init
let _enabled = false
let _instanceId: string = randomUUID()
let _plexoVersion = '0.1.0'
let _redis: RedisClientType | null = null

export function configureTelemetry(opts: {
    enabled: boolean
    instanceId: string
    plexoVersion: string
    redisUrl?: string
}): void {
    _enabled = opts.enabled
    _instanceId = opts.instanceId
    _plexoVersion = opts.plexoVersion

    if (opts.redisUrl && !_redis) {
        _redis = createRedis({ url: opts.redisUrl }) as RedisClientType
        void _redis.connect().catch(() => { /* redis optional for telemetry */ })
    }
}

export function getTelemetryConfig(): { enabled: boolean; instanceId: string } {
    return { enabled: _enabled, instanceId: _instanceId }
}

export function setTelemetryEnabled(enabled: boolean): void {
    _enabled = enabled
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

    if (!_enabled) return

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
