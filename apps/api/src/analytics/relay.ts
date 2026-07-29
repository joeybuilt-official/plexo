// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Native analytics relay — fire-and-forget POST to Command Engine.
 * Fire-and-forget POST to the upstream analytics ingest.
 * Never blocks, never throws. 5s timeout.
 */

import pino from 'pino'

const logger = pino({ name: 'analytics-relay' })

const RELAY_URL = process.env.ANALYTICS_RELAY_URL ?? ''
const RELAY_KEY = process.env.ANALYTICS_RELAY_KEY ?? ''

/** POST an event to the upstream analytics ingest. */
export async function relayEvent(
    body: { event_name: string; properties: Record<string, unknown>; plexo_version?: string; node_version?: string },
    instanceId: string,
): Promise<void> {
    if (!RELAY_URL) return
    try {
        await fetch(`${RELAY_URL}/events`, {
            method: 'POST',
            headers: headers(instanceId),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        })
    } catch (err) {
        logger.debug({ err }, 'Relay event POST failed — suppressed')
    }
}

/** POST a sanitized error to the upstream analytics ingest. */
export async function relayError(
    body: { fingerprint: string; message: string; stack_trace?: string; context?: Record<string, unknown>; deploy_id?: string },
    instanceId: string,
): Promise<void> {
    if (!RELAY_URL) return
    try {
        await fetch(`${RELAY_URL}/errors`, {
            method: 'POST',
            headers: headers(instanceId),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        })
    } catch (err) {
        logger.debug({ err }, 'Relay error POST failed — suppressed')
    }
}

function headers(instanceId: string): Record<string, string> {
    const h: Record<string, string> = {
        'content-type': 'application/json',
        'x-instance-id': instanceId,
    }
    if (RELAY_KEY) h['x-service-key'] = RELAY_KEY
    return h
}
