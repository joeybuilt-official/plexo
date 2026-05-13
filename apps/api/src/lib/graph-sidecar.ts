// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * HTTP client for the graphiti sidecar's direct FalkorDB endpoints
 * (`/v1/graph/write`, `/v1/graph/cypher`). Added in Phase B2 of the
 * FalkorDB platform migration (ADR 0021).
 *
 * Auth envelope is symmetrical to `lib/gmessages-sidecar.ts` and to
 * `services/graphiti-sidecar/main.py:_verify_hmac`:
 *   - PLEXO_SERVICE_KEY shared secret signs the raw JSON body
 *   - X-Plexo-Signature: sha256=<hex>
 *   - X-Plexo-Timestamp: ISO-8601 (±5 min tolerance on the sidecar)
 *   - X-App-Id identifies the calling app (telemetry only)
 *
 * Base URL comes from PLEXO_GRAPHITI_SIDECAR_URL — the same env var
 * apps/api/src/routes/graph.ts uses for the bridge client.
 */

import { createHmac } from 'node:crypto'

const APP_ID = 'plexo-api'

function sidecarBaseUrl(): string | null {
    return process.env.PLEXO_GRAPHITI_SIDECAR_URL ?? null
}

function serviceKey(): string | null {
    return process.env.PLEXO_SERVICE_KEY ?? null
}

function sign(body: string, key: string): { sig: string; ts: string } {
    const sig = 'sha256=' + createHmac('sha256', key).update(body).digest('hex')
    const ts = new Date().toISOString()
    return { sig, ts }
}

export interface GraphNode {
    label: string
    id: string
    properties: Record<string, unknown>
}

export interface GraphEdge {
    type: string
    from_label: string
    from_id: string
    to_label: string
    to_id: string
    properties?: Record<string, unknown>
}

export interface GraphWriteRequest {
    workspace_id: string
    app?: string
    nodes?: GraphNode[]
    edges?: GraphEdge[]
}

export interface GraphWriteResponse {
    nodes_written: number
    edges_written: number
    latencies: { lock_wait_ms: number; write_ms: number }
}

export interface GraphCypherRequest {
    workspace_id: string
    cypher: string
    params?: Record<string, unknown>
}

export interface GraphCypherResponse {
    header: string[]
    rows: unknown[][]
}

/** Returns true iff both env vars are set, so callers can no-op cleanly
 *  outside of integration deployments. */
export function isGraphSidecarConfigured(): boolean {
    return Boolean(sidecarBaseUrl() && serviceKey())
}

/** POST /v1/graph/write — structured node/edge upsert. */
export async function graphWrite(req: GraphWriteRequest): Promise<GraphWriteResponse> {
    const base = sidecarBaseUrl()
    const key = serviceKey()
    if (!base || !key) {
        throw new Error('PLEXO_GRAPHITI_SIDECAR_URL or PLEXO_SERVICE_KEY not set — sidecar unavailable')
    }
    const body = JSON.stringify(req)
    const { sig, ts } = sign(body, key)
    const res = await fetch(base.replace(/\/+$/, '') + '/v1/graph/write', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-App-Id': APP_ID,
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
        body,
        signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`graph sidecar /v1/graph/write ${res.status}: ${text}`)
    }
    return (await res.json()) as GraphWriteResponse
}

/** POST /v1/graph/cypher — arbitrary cypher (read OR write). */
export async function graphCypher(req: GraphCypherRequest): Promise<GraphCypherResponse> {
    const base = sidecarBaseUrl()
    const key = serviceKey()
    if (!base || !key) {
        throw new Error('PLEXO_GRAPHITI_SIDECAR_URL or PLEXO_SERVICE_KEY not set — sidecar unavailable')
    }
    const body = JSON.stringify(req)
    const { sig, ts } = sign(body, key)
    const res = await fetch(base.replace(/\/+$/, '') + '/v1/graph/cypher', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-App-Id': APP_ID,
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
        body,
        signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`graph sidecar /v1/graph/cypher ${res.status}: ${text}`)
    }
    return (await res.json()) as GraphCypherResponse
}
