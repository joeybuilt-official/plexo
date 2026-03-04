/**
 * PostHog client — anonymous crash reporting.
 *
 * PostHog is self-hosted on Plexo infrastructure. No data touches PostHog cloud.
 * The client is a no-op when telemetry is disabled.
 */
import { createClient as createRedis, type RedisClientType } from 'redis'
import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { sanitize, type RawErrorContext, type TelemetryError } from './sanitize.js'

const logger = pino({ name: 'telemetry' })

const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://telemetry.getplexo.com'
const POSTHOG_KEY = process.env.POSTHOG_API_KEY ?? 'phc_plexo_self_hosted'

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
        _redis.connect().catch(() => { /* redis optional for telemetry */ })
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
 * Only POSTs to PostHog if telemetry is enabled.
 */
export async function captureError(ctx: Omit<RawErrorContext, 'instanceId' | 'plexoVersion'>): Promise<void> {
    const payload = sanitize({ ...ctx, instanceId: _instanceId, plexoVersion: _plexoVersion })

    // Always store last payload — shown in UI whether enabled or not
    await storeLastPayload(payload)

    if (!_enabled) return

    try {
        await fetch(`${POSTHOG_HOST}/capture/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                api_key: POSTHOG_KEY,
                event: 'crash',
                distinct_id: _instanceId,
                properties: payload,
                timestamp: new Date().toISOString(),
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
