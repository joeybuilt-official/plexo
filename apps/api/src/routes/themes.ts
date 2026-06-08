// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Themes routes (Phase 8). Public service-key surface that Nexalog's
 * `/app/graph` calls for a multi-level thematic forest of the user's
 * workspace knowledge graph. Mirrors routes/graph.ts: requireServiceKey
 * (Bearer + X-App-Id), workspaceId rides the query string, all graph I/O
 * goes through the Graphiti sidecar via graphCypher.
 *
 * The forest is clustered on demand (see lib/themes-forest.ts) and cached
 * per workspace for FOREST_TTL_MS so repeated loads / the d3 viz re-fetch
 * don't re-run clustering every time.
 */

import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import pino from 'pino'
import { graphCypher, isGraphSidecarConfigured } from '../lib/graph-sidecar.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import {
    buildForest,
    type EntityEdge,
    type EntityMeta,
    type MentionEdge,
    type ThemesForest,
} from '../lib/themes-forest.js'

const logger = pino({ name: 'themes-routes' })
const router: import('express').Router = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FOREST_TTL_MS = 10 * 60 * 1000
const EDGE_LIMIT = 5000
const MENTION_LIMIT = 8000

interface CacheEntry {
    forest: ThemesForest
    expires: number
}
const cache = new Map<string, CacheEntry>()

router.use(requireServiceKey)

function colIndex(header: string[], name: string): number {
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`column ${name} missing from sidecar response`)
    return i
}

function asString(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v)
}

async function computeForest(workspaceId: string): Promise<ThemesForest> {
    const runId = randomUUID()
    const generatedAt = new Date().toISOString()

    // Entity–entity edges (undirected, deduped by uuid order) + endpoint names.
    const edgesRes = await graphCypher({
        workspace_id: workspaceId,
        cypher:
            'MATCH (a:Entity)-[:RELATES_TO]-(b:Entity) WHERE a.uuid < b.uuid ' +
            `RETURN a.uuid AS au, a.name AS an, b.uuid AS bu, b.name AS bn LIMIT ${EDGE_LIMIT}`,
    })
    const eh = edgesRes.header
    const iau = colIndex(eh, 'au')
    const ian = colIndex(eh, 'an')
    const ibu = colIndex(eh, 'bu')
    const ibn = colIndex(eh, 'bn')
    const entityEdges: EntityEdge[] = []
    const entityMeta = new Map<string, EntityMeta>()
    for (const row of edgesRes.rows) {
        const au = asString(row[iau])
        const bu = asString(row[ibu])
        if (!au || !bu) continue
        entityEdges.push({ a: au, b: bu })
        if (!entityMeta.has(au)) entityMeta.set(au, { uuid: au, name: asString(row[ian]) })
        if (!entityMeta.has(bu)) entityMeta.set(bu, { uuid: bu, name: asString(row[ibn]) })
    }

    // Episodic → Entity mentions, for member placement.
    let mentions: MentionEdge[] = []
    try {
        const mRes = await graphCypher({
            workspace_id: workspaceId,
            cypher:
                'MATCH (e:Episodic)-[:MENTIONS]->(n:Entity) ' +
                `RETURN e.uuid AS eu, e.name AS en, e.source_description AS sd, n.uuid AS nu LIMIT ${MENTION_LIMIT}`,
        })
        const mh = mRes.header
        const ieu = colIndex(mh, 'eu')
        const ien = colIndex(mh, 'en')
        const isd = colIndex(mh, 'sd')
        const inu = colIndex(mh, 'nu')
        mentions = mRes.rows
            .map((row) => ({
                episodeId: asString(row[ieu]),
                episodeLabel: asString(row[ien]),
                episodeKind: kindFromSource(asString(row[isd])),
                entityId: asString(row[inu]),
            }))
            .filter((m) => m.episodeId && m.entityId)
    } catch (err) {
        // Members are a nice-to-have; a forest of pure concept clusters is
        // still useful. Never fail the whole forest on the mentions query.
        logger.warn({ workspaceId, err: (err as Error).message }, 'themes.forest: mentions query failed')
    }

    return buildForest({ entityEdges, entityMeta, mentions, runId, generatedAt })
}

/** Coarse member kind from an Episodic's `source_description`
 *  (`app:<id>|src:<x>`). We can't distinguish note vs bookmark from the
 *  graph, so everything is a generic note for the viz. */
function kindFromSource(sd: string): string {
    if (/bookmark/i.test(sd)) return 'bookmark'
    return 'note'
}

router.get('/forest', async (req, res) => {
    const workspaceId = req.query.workspaceId
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE_ID', message: 'workspaceId must be a UUID' } })
        return
    }
    if (!isGraphSidecarConfigured()) {
        res.status(503).json({ error: { code: 'SIDECAR_UNCONFIGURED', message: 'graphiti sidecar URL or service key not set' } })
        return
    }

    const refresh = req.query.refresh === '1'
    const cached = cache.get(workspaceId)
    if (!refresh && cached && cached.expires > Date.now()) {
        res.json(cached.forest)
        return
    }

    try {
        const forest = await computeForest(workspaceId)
        cache.set(workspaceId, { forest, expires: Date.now() + FOREST_TTL_MS })
        res.json(forest)
    } catch (err) {
        logger.warn({ workspaceId, err: (err as Error).message }, 'themes.forest: compute failed')
        res.status(502).json({ error: { code: 'FOREST_ERROR', message: (err as Error).message } })
    }
})

export const themesRouter = router
