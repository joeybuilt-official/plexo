// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * gmessages.session.refresh-receiver (ADR-0006).
 *
 * Phase 5: consumer of `gmessages.session.refresh-requested` events emitted
 * by the Phase 4b `gmessages-session-refresh` cron. HMAC-POSTs the sidecar's
 * `/sessions/:pairedSessionId/refresh` endpoint, which calls
 * libgm.Client.RefreshPhoneRelay() on the running session goroutine.
 *
 * Errors are logged but not rethrown — Inngest's retry policy applies on
 * thrown errors, but a 5xx from the sidecar should not pile up retries
 * forever; the next cron tick (15 min) re-queues if the session is still
 * stale. We *do* throw on missing env so a misconfigured deployment is
 * loud rather than silent.
 */

import { createHmac } from 'node:crypto'
import { inngest } from '../client.js'

const APP_ID = 'plexo-api'

function sidecarBaseUrl(): string {
    return process.env.GMESSAGES_SIDECAR_URL ?? 'http://gmessages:3010'
}

function serviceKey(): string {
    const k = process.env.PLEXO_SERVICE_KEY
    if (!k) throw new Error('PLEXO_SERVICE_KEY not set — sidecar HMAC unavailable')
    return k
}

function sign(body: string): { sig: string; ts: string } {
    const sig = 'sha256=' + createHmac('sha256', serviceKey()).update(body).digest('hex')
    const ts = new Date().toISOString()
    return { sig, ts }
}

export const gmessagesSessionRefreshReceiver = inngest.createFunction(
    { id: 'gmessages-session-refresh-receiver' },
    { event: 'gmessages.session.refresh-requested' },
    async ({ event, step, logger }) => {
        const { pairedSessionId, workspaceId } = event.data

        const result = await step.run('hmac-post-refresh', async () => {
            const body = '{}'
            const { sig, ts } = sign(body)
            const url = sidecarBaseUrl() + `/sessions/${encodeURIComponent(pairedSessionId)}/refresh`
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-App-Id': APP_ID,
                        'X-Plexo-Timestamp': ts,
                        'X-Plexo-Signature': sig,
                    },
                    body,
                })
                return { ok: res.ok, status: res.status }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                return { ok: false, status: 0, error: message }
            }
        })

        if (!result.ok) {
            logger.warn(
                { pairedSessionId, workspaceId, status: result.status },
                'gmessages session refresh: sidecar non-OK',
            )
            return { ok: false, status: result.status }
        }
        logger.info({ pairedSessionId, workspaceId }, 'gmessages session refresh dispatched to sidecar')
        return { ok: true, status: result.status }
    },
)
