// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * @plexo/graphiti-bridge — Phase 2 scaffold (ADR 0011).
 *
 * HMAC-signed HTTP client for the plexo-graphiti Python sidecar. Mirrors
 * the gmessages-session-refresh-receiver signing scheme: SHA256 HMAC of
 * the request body keyed by PLEXO_SERVICE_KEY, plus an ISO timestamp.
 *
 * Null-on-failure semantics match the rest of @joeybuilt/plexo-sdk so callers can
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
    /** Free-text provenance string. Default: 'plexo-bridge'. */
    sourceDescription?: string
    /** Episode display name. Default: 'episode'. */
    name?: string
    /** EpisodeType — 'message' (default) | 'text' | 'json'. */
    episodeType?: string
    /** ISO-8601 reference time for bi-temporal placement. Default: server's now(). */
    referenceTime?: string
    sourceMetadata?: Record<string, unknown>
}

export interface AddEpisodeResult {
    episodeId: string | null
    extractedFactsCount: number
    extractedNodesCount: number
}

export interface SearchRequest {
    workspaceId: string
    query: string
    numResults?: number
}

export interface SearchResultEdge {
    uuid: string | null
    fact: string | null
    source_node_uuid: string | null
    target_node_uuid: string | null
    valid_at: string | null
    invalid_at: string | null
    created_at: string | null
}

export interface SearchResult {
    results: SearchResultEdge[]
}

export interface CypherRequest {
    workspaceId: string
    cypher: string
    params?: Record<string, unknown>
}

export interface CypherResponse {
    header: string[]
    rows: unknown[][]
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

    /** Phase 3c: posts an episode to the sidecar's Graphiti.add_episode wrapper. */
    async addEpisode(req: AddEpisodeRequest): Promise<AddEpisodeResult | null> {
        const body = JSON.stringify({
            workspace_id: req.workspaceId,
            name: req.name ?? 'episode',
            content: req.content,
            source_description: req.sourceDescription ?? 'plexo-bridge',
            episode_type: req.episodeType ?? 'message',
            reference_time: req.referenceTime,
            source_metadata: req.sourceMetadata ?? {},
        })
        const raw = await this.postSigned<{ episode_id: string | null; extracted_facts_count: number; extracted_nodes_count: number }>('/v1/episodes', body)
        if (!raw) return null
        return {
            episodeId: raw.episode_id,
            extractedFactsCount: raw.extracted_facts_count,
            extractedNodesCount: raw.extracted_nodes_count,
        }
    }

    /**
     * Phase A2 (ADR 0018): arbitrary cypher (read or write) against the
     * workspace's FalkorDB graph. HMAC-signed; sidecar serializes Node/Edge
     * values to `{labels, properties, id}` shapes.
     */
    async cypher(req: CypherRequest): Promise<CypherResponse | null> {
        const body = JSON.stringify({
            workspace_id: req.workspaceId,
            cypher: req.cypher,
            params: req.params ?? {},
        })
        return this.postSigned<CypherResponse>('/v1/graph/cypher', body)
    }

    /** Phase 3c: hybrid-search query against the workspace's Graphiti store. */
    async search(req: SearchRequest): Promise<SearchResult | null> {
        const body = JSON.stringify({
            workspace_id: req.workspaceId,
            query: req.query,
            num_results: req.numResults ?? 10,
        })
        return this.postSigned<SearchResult>('/v1/search', body)
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
