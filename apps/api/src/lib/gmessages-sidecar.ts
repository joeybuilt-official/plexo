// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * HMAC client for the apps/gmessages Go sidecar (ADR-0001).
 *
 * Symmetrical to apps/api/src/middleware/hmac-service.ts: same
 * PLEXO_SERVICE_KEY shared secret, same X-Plexo-Signature/Timestamp/App-Id
 * envelope. The sidecar verifies via internal/httpauth/RequireHMAC.
 *
 * Used by /api/v1/connections/gmessages/{pair-start,pair-status} (Phase 4a)
 * and Phase 4b's session.refresh / stale-session-monitor jobs.
 */

import { createHmac } from 'node:crypto'

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

export interface PairStartResponse {
    pairingId: string
    qrUrl: string
    expiresAt: string
}

export interface PairStatusResponse {
    pairingId: string
    state: 'waiting' | 'linked' | 'expired' | 'errored'
    authBlob?: string  // base64-encoded JSON of libgm AuthData; only on linked
    errorDetail?: string
    expiresAt: string
}

export async function sidecarPairStart(): Promise<PairStartResponse> {
    const body = ''
    const { sig, ts } = sign(body)
    const res = await fetch(sidecarBaseUrl() + '/pair/start', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-App-Id': APP_ID,
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`gmessages sidecar /pair/start ${res.status}: ${text}`)
    }
    return await res.json() as PairStartResponse
}

export async function sidecarPairStatus(pairingId: string): Promise<PairStatusResponse> {
    const body = ''
    const { sig, ts } = sign(body)
    const url = new URL('/pair/status', sidecarBaseUrl())
    url.searchParams.set('id', pairingId)
    const res = await fetch(url, {
        method: 'GET',
        headers: {
            'X-App-Id': APP_ID,
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
    })
    if (res.status === 404) {
        return { pairingId, state: 'expired', expiresAt: new Date().toISOString() }
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`gmessages sidecar /pair/status ${res.status}: ${text}`)
    }
    return await res.json() as PairStatusResponse
}

export async function sidecarPairDiscard(pairingId: string): Promise<void> {
    const body = JSON.stringify({ pairingId })
    const { sig, ts } = sign(body)
    const res = await fetch(sidecarBaseUrl() + '/pair/discard', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-App-Id': APP_ID,
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
        body,
    })
    if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => '')
        throw new Error(`gmessages sidecar /pair/discard ${res.status}: ${text}`)
    }
}

// ── Phase 5 — outbound dispatch + per-session refresh ─────────────────────

export interface SidecarSessionSendResponse {
    accepted: true
    /** Sidecar-supplied id if libgm returned one; otherwise the request idempotency key. */
    messageId?: string
}

/**
 * POST /sessions/:pairedSessionId/send — outbound message dispatch into the
 * running libgm session. The sidecar drives libgm.Client.Send* and returns
 * 202 once the request is queued; the user-visible delivery state arrives
 * later via the inbound stream (echo) plus heartbeat.
 */
export async function sidecarSessionSend(
    pairedSessionId: string,
    threadId: string,
    text: string,
    idempotencyKey: string,
): Promise<SidecarSessionSendResponse> {
    const body = JSON.stringify({ threadId, text, idempotencyKey })
    const { sig, ts } = sign(body)
    const res = await fetch(sidecarBaseUrl() + `/sessions/${encodeURIComponent(pairedSessionId)}/send`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-App-Id': APP_ID,
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
        body,
    })
    if (!res.ok && res.status !== 202) {
        const t = await res.text().catch(() => '')
        throw new Error(`gmessages sidecar /sessions/${pairedSessionId}/send ${res.status}: ${t}`)
    }
    try {
        return await res.json() as SidecarSessionSendResponse
    } catch {
        return { accepted: true }
    }
}

/**
 * POST /sessions/:pairedSessionId/refresh — calls libgm.Client.RefreshPhoneRelay
 * on the running goroutine. Consumed by the Inngest receiver for
 * `gmessages.session.refresh-requested`.
 */
export async function sidecarSessionRefresh(pairedSessionId: string): Promise<void> {
    const body = '{}'
    const { sig, ts } = sign(body)
    const res = await fetch(sidecarBaseUrl() + `/sessions/${encodeURIComponent(pairedSessionId)}/refresh`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-App-Id': APP_ID,
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
        body,
    })
    if (!res.ok && res.status !== 202 && res.status !== 204) {
        const t = await res.text().catch(() => '')
        throw new Error(`gmessages sidecar /sessions/${pairedSessionId}/refresh ${res.status}: ${t}`)
    }
}
