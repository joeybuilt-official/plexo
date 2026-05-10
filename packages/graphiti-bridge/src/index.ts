// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * @plexo/graphiti-bridge — Phase 2 scaffold (ADR 0011).
 *
 * HMAC-signed HTTP client for the plexo-graphiti Python sidecar. Mirrors
 * the gmessages-session-refresh-receiver signing scheme: SHA256 HMAC of
 * the request body keyed by PLEXO_SERVICE_KEY, plus an ISO timestamp.
 *
 * Null-on-failure semantics match the rest of @plexo/sdk so callers can
 * treat the bridge as best-effort during the migration window.
 */

import { createHmac } from 'node:crypto'

export interface GraphitiClientConfig {
    baseUrl: string
    serviceKey: string
    appId?: string
    fetchImpl?: typeof fetch
}

export interface HealthResponse {
    ok: boolean
    service: string
    kuzu_data_dir: string
    hmac_configured: boolean
    phase: string
}

export interface AddEpisodeRequest {
    workspaceId: string
    content: string
    episodeType?: string
    sourceMetadata?: Record<string, unknown>
}

export interface SearchRequest {
    workspaceId: string
    query: string
    numResults?: number
}

const APP_ID_DEFAULT = 'plexo-api'

function sign(serviceKey: string, body: string): { sig: string; ts: string } {
    const sig = 'sha256=' + createHmac('sha256', serviceKey).update(body).digest('hex')
    const ts = new Date().toISOString()
    return { sig, ts }
}

export class GraphitiClient {
    private readonly baseUrl: string
    private readonly serviceKey: string
    private readonly appId: string
    private readonly fetchImpl: typeof fetch

    constructor(config: GraphitiClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, '')
        this.serviceKey = config.serviceKey
        this.appId = config.appId ?? APP_ID_DEFAULT
        this.fetchImpl = config.fetchImpl ?? fetch
    }

    /** No HMAC — public readiness endpoint. */
    async health(): Promise<HealthResponse | null> {
        try {
            const res = await this.fetchImpl(`${this.baseUrl}/v1/health`)
            if (!res.ok) return null
            return (await res.json()) as HealthResponse
        } catch {
            return null
        }
    }

    /** Phase 3 wires the actual Graphiti add_episode call. Phase 2 stub returns null. */
    async addEpisode(req: AddEpisodeRequest): Promise<{ episodeId: string } | null> {
        const body = JSON.stringify({
            workspace_id: req.workspaceId,
            content: req.content,
            episode_type: req.episodeType ?? 'message',
            source_metadata: req.sourceMetadata ?? {},
        })
        return this.postSigned<{ episodeId: string }>('/v1/episodes', body)
    }

    /** Phase 3 wires search recipes. Phase 2 stub returns null. */
    async search(req: SearchRequest): Promise<{ results: unknown[] } | null> {
        const body = JSON.stringify({
            workspace_id: req.workspaceId,
            query: req.query,
            num_results: req.numResults ?? 10,
        })
        return this.postSigned<{ results: unknown[] }>('/v1/search', body)
    }

    private async postSigned<T>(path: string, body: string): Promise<T | null> {
        const { sig, ts } = sign(this.serviceKey, body)
        try {
            const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-App-Id': this.appId,
                    'X-Plexo-Timestamp': ts,
                    'X-Plexo-Signature': sig,
                },
                body,
            })
            if (!res.ok) return null
            return (await res.json()) as T
        } catch {
            return null
        }
    }
}
