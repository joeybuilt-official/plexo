// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Graph routes — Phase 8 of `graphiti-migration/plan.md`. Public surface
 * the `@joeybuilt/plexo-sdk` 1.1.0 graph methods (`addEpisode`,
 * `searchFacts`) call into. Each request goes through the existing
 * `requireServiceKey` middleware (Bearer + X-App-Id) and proxies through
 * `@plexo/graphiti-bridge` to the Python sidecar.
 *
 * Workspace ID rides the request body for POST + a `workspaceId` query
 * param for GET. The body shape is the SDK's, not Graphiti's, so the SDK
 * stays insulated from upstream graphiti-core API name churn.
 *
 * Methods deferred to SDK 1.2.0:
 *   - searchNodes — graphiti-core 0.29 has no `search_nodes` method;
 *     would need to call `Graphiti.search_()` (richer SearchResults) and
 *     project to nodes, plus a sidecar endpoint to surface that.
 *   - getCommunity — `build_communities` is a builder, not a getter; no
 *     accessor exists for previously-built communities. Needs custom
 *     Cypher/Kuzu queries on the sidecar side.
 */

import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import pino from 'pino'
import { GraphitiClient } from '@plexo/graphiti-bridge'
import { graphCypher, isGraphSidecarConfigured } from '../lib/graph-sidecar.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'

const logger = pino({ name: 'graph-routes' })
const router: import('express').Router = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let _client: GraphitiClient | null = null
function getClient(): GraphitiClient | null {
    if (_client) return _client
    const baseUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) return null
    _client = new GraphitiClient({ baseUrl, serviceKey, appId: 'plexo-api-graph-routes' })
    return _client
}

/** Test hook. */
export function resetGraphRouterForTest(): void {
    _client = null
}
export function setGraphRouterClientForTest(c: GraphitiClient | null): void {
    _client = c
}

router.use(requireServiceKey)

interface AddEpisodeBody {
    workspaceId?: string
    content?: string
    name?: string
    sourceDescription?: string
    referenceTime?: string
    metadata?: Record<string, unknown>
}

router.post('/episodes', async (req, res) => {
    const body = req.body as AddEpisodeBody | undefined
    if (!body || typeof body.workspaceId !== 'string' || !UUID_RE.test(body.workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE_ID', message: 'workspaceId must be a UUID' } })
        return
    }
    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
        res.status(400).json({ error: { code: 'EMPTY_CONTENT', message: 'content must be a non-empty string' } })
        return
    }
    const client = getClient()
    if (!client) {
        res.status(503).json({ error: { code: 'BRIDGE_UNCONFIGURED', message: 'graphiti sidecar URL or service key not set' } })
        return
    }
    // A3 S1 — allocate plexo_memory_id at the proxy boundary if the SDK
    // caller didn't supply one, so every Episodic node has a stable
    // plexo-side identity.
    const incomingMeta = body.metadata ?? {}
    const sourceMetadata =
        typeof incomingMeta.plexo_memory_id === 'string' && incomingMeta.plexo_memory_id.length > 0
            ? incomingMeta
            : { ...incomingMeta, plexo_memory_id: randomUUID() }
    const result = await client.addEpisode({
        workspaceId: body.workspaceId,
        content: body.content,
        name: body.name,
        sourceDescription: body.sourceDescription ?? `app:${req.serviceContext?.appId ?? 'unknown'}|src:sdk`,
        referenceTime: body.referenceTime,
        sourceMetadata,
        episodeType: 'message',
    })
    if (!result) {
        logger.warn({ workspaceId: body.workspaceId }, 'graph.episodes: bridge returned null')
        res.status(502).json({ error: { code: 'BRIDGE_ERROR', message: 'graphiti add_episode failed' } })
        return
    }
    res.json({
        episodeId: result.episodeId,
        extractedFactsCount: result.extractedFactsCount,
        extractedNodesCount: result.extractedNodesCount,
    })
})

router.get('/facts/search', async (req, res) => {
    const workspaceId = req.query.workspaceId
    const query = req.query.q
    const limit = Number(req.query.limit ?? 10)
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE_ID', message: 'workspaceId must be a UUID' } })
        return
    }
    if (typeof query !== 'string' || query.trim().length === 0) {
        res.status(400).json({ error: { code: 'EMPTY_QUERY', message: 'q must be a non-empty string' } })
        return
    }
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
        res.status(400).json({ error: { code: 'INVALID_LIMIT', message: 'limit must be between 1 and 100' } })
        return
    }
    const client = getClient()
    if (!client) {
        res.status(503).json({ error: { code: 'BRIDGE_UNCONFIGURED', message: 'graphiti sidecar URL or service key not set' } })
        return
    }
    const result = await client.search({ workspaceId, query, numResults: limit })
    if (!result) {
        logger.warn({ workspaceId, query }, 'graph.facts.search: bridge returned null')
        res.status(502).json({ error: { code: 'BRIDGE_ERROR', message: 'graphiti search failed' } })
        return
    }
    res.json({ results: result.results })
})

// Read-only cypher proxy for graph-viz consumers (Nexalog explorer, ADR 0026).
// Blocks mutating clauses so a service-key caller can't write through this
// surface; structured writes go through /v1/graph/write on the sidecar.
const CYPHER_WRITE_RE = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD\s+CSV)\b/i

interface CypherBody {
    workspaceId?: string
    cypher?: string
    params?: Record<string, unknown>
}

router.post('/cypher', async (req, res) => {
    const body = req.body as CypherBody | undefined
    if (!body || typeof body.workspaceId !== 'string' || !UUID_RE.test(body.workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE_ID', message: 'workspaceId must be a UUID' } })
        return
    }
    if (typeof body.cypher !== 'string' || body.cypher.trim().length === 0) {
        res.status(400).json({ error: { code: 'EMPTY_CYPHER', message: 'cypher must be a non-empty string' } })
        return
    }
    if (CYPHER_WRITE_RE.test(body.cypher)) {
        res.status(400).json({ error: { code: 'WRITE_FORBIDDEN', message: 'this surface is read-only' } })
        return
    }
    if (!isGraphSidecarConfigured()) {
        res.status(503).json({ error: { code: 'SIDECAR_UNCONFIGURED', message: 'graphiti sidecar URL or service key not set' } })
        return
    }
    try {
        const result = await graphCypher({
            workspace_id: body.workspaceId,
            cypher: body.cypher,
            params: body.params ?? {},
        })
        res.json(result)
    } catch (err) {
        logger.warn({ workspaceId: body.workspaceId, err: (err as Error).message }, 'graph.cypher: sidecar error')
        res.status(502).json({ error: { code: 'SIDECAR_ERROR', message: (err as Error).message } })
    }
})

export const graphRouter = router
