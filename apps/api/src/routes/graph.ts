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
    /** Route extraction through this workspace's providers while writing the
     *  graph under workspaceId. See GraphitiClient.addEpisode. */
    inferenceWorkspaceId?: string
    /** Optional custom entity taxonomy forwarded to graphiti so extracted
     *  nodes are typed instead of bare `Entity` (P9c). Each {name, description}
     *  becomes a graphiti entity type; name must be a valid label identifier. */
    entityTypes?: Array<{ name?: unknown; description?: unknown }>
}

// Entity-type names become FalkorDB node labels, so constrain them to a safe
// identifier shape (the sidecar interpolates the name as a label). Reject
// anything else rather than silently dropping it.
const ENTITY_TYPE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const MAX_ENTITY_TYPES = 24

function sanitizeEntityTypes(
    raw: Array<{ name?: unknown; description?: unknown }> | undefined,
): Array<{ name: string; description: string }> | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    const out: Array<{ name: string; description: string }> = []
    for (const t of raw.slice(0, MAX_ENTITY_TYPES)) {
        if (!t || typeof t.name !== 'string' || !ENTITY_TYPE_NAME_RE.test(t.name)) continue
        out.push({ name: t.name, description: typeof t.description === 'string' ? t.description : '' })
    }
    return out.length > 0 ? out : undefined
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
    if (body.inferenceWorkspaceId !== undefined && !UUID_RE.test(body.inferenceWorkspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_INFERENCE_WORKSPACE_ID', message: 'inferenceWorkspaceId must be a UUID' } })
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
        inferenceWorkspaceId: body.inferenceWorkspaceId,
        entityTypes: sanitizeEntityTypes(body.entityTypes),
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

interface RemoveEpisodeBody {
    workspaceId?: string
    episodeId?: string
}

router.post('/episodes/delete', async (req, res) => {
    const body = req.body as RemoveEpisodeBody | undefined
    if (!body || typeof body.workspaceId !== 'string' || !UUID_RE.test(body.workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE_ID', message: 'workspaceId must be a UUID' } })
        return
    }
    if (typeof body.episodeId !== 'string' || body.episodeId.trim().length === 0) {
        res.status(400).json({ error: { code: 'INVALID_EPISODE_ID', message: 'episodeId must be a non-empty string' } })
        return
    }
    const client = getClient()
    if (!client) {
        res.status(503).json({ error: { code: 'BRIDGE_UNCONFIGURED', message: 'graphiti sidecar URL or service key not set' } })
        return
    }
    const ok = await client.removeEpisode({ workspaceId: body.workspaceId, episodeId: body.episodeId })
    if (!ok) {
        logger.warn({ workspaceId: body.workspaceId }, 'graph.episodes.delete: bridge returned false')
        res.status(502).json({ error: { code: 'BRIDGE_ERROR', message: 'graphiti remove_episode failed' } })
        return
    }
    res.json({ ok: true })
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
//
// Defense in depth (ADR 0002): comments are stripped first so a write keyword
// can't hide behind `//` / `/* */`; write-procedures (apoc create/merge/...) and
// FOREACH are covered in addition to the bare write clauses. Conservative: a
// false positive only blocks a read; a false negative would allow a write.
const CYPHER_WRITE_RE =
    /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|FOREACH|LOAD\s+CSV)\b|\bCALL\s+apoc\.\w*(create|merge|delete|set|remove|refactor)/i

function stripCypherComments(cypher: string): string {
    return cypher.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

export function isWriteCypher(cypher: string): boolean {
    return CYPHER_WRITE_RE.test(stripCypherComments(cypher))
}

// Server-side row cap (ADR 0002, defense-in-depth): a service-key caller must
// not be able to pull an unbounded result set out of the shared FalkorDB. We
// clamp the query's final LIMIT to MAX_CYPHER_LIMIT, and append one if absent.
// Conservative: comments are stripped before scanning so a commented-out LIMIT
// can't fool the clamp; the real query text is what we rewrite.
export const MAX_CYPHER_LIMIT = 5000

export function clampCypherLimit(cypher: string): string {
    // Operate on the comment-stripped text: comments are no-ops in cypher, so
    // returning the stripped query is safe and avoids offset drift (and a
    // commented-out LIMIT can't fool the clamp).
    const clean = stripCypherComments(cypher)
    const re = /\blimit\s+(\d+)\b/gi
    let m: RegExpExecArray | null
    let last: RegExpExecArray | null = null
    while ((m = re.exec(clean)) !== null) last = m
    if (!last) {
        return `${clean.replace(/[\s;]+$/, '')} LIMIT ${MAX_CYPHER_LIMIT}`
    }
    if (parseInt(last[1] ?? '0', 10) <= MAX_CYPHER_LIMIT) return clean
    return clean.slice(0, last.index) + `LIMIT ${MAX_CYPHER_LIMIT}` + clean.slice(last.index + last[0].length)
}

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
    if (isWriteCypher(body.cypher)) {
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
            cypher: clampCypherLimit(body.cypher),
            params: body.params ?? {},
        })
        res.json(result)
    } catch (err) {
        logger.warn({ workspaceId: body.workspaceId, err: (err as Error).message }, 'graph.cypher: sidecar error')
        res.status(502).json({ error: { code: 'SIDECAR_ERROR', message: (err as Error).message } })
    }
})

export const graphRouter = router
