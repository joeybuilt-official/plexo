// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared themes-forest compute + per-workspace cache. Used by both the
 * /api/v1/themes route (the clustered graph view) and the
 * /api/v1/synthesis route (suggestions derived from the same forest), so
 * they don't each re-cluster the graph.
 */

import { randomUUID } from 'node:crypto'
import { graphCypher } from './graph-sidecar.js'
import {
    buildForest,
    type EntityEdge,
    type EntityMeta,
    type MentionEdge,
    type ThemesForest,
} from './themes-forest.js'

const FOREST_TTL_MS = 10 * 60 * 1000
const EDGE_LIMIT = 5000
const MENTION_LIMIT = 8000

interface CacheEntry {
    forest: ThemesForest
    expires: number
}
const cache = new Map<string, CacheEntry>()

function colIndex(header: string[], name: string): number {
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`column ${name} missing from sidecar response`)
    return i
}

function asString(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** Coarse member kind from an Episodic's source_description. We can't tell
 *  note vs bookmark from the graph, so everything is a generic note. */
function kindFromSource(sd: string): string {
    if (/bookmark/i.test(sd)) return 'bookmark'
    return 'note'
}

async function computeForest(workspaceId: string): Promise<ThemesForest> {
    const runId = randomUUID()
    const generatedAt = new Date().toISOString()

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
    } catch {
        // Members are a nice-to-have; never fail the forest on the mentions query.
    }

    return buildForest({ entityEdges, entityMeta, mentions, runId, generatedAt })
}

/** Returns the workspace forest, served from a 10-minute cache unless
 *  `refresh` is set. */
export async function getForest(workspaceId: string, refresh = false): Promise<ThemesForest> {
    const cached = cache.get(workspaceId)
    if (!refresh && cached && cached.expires > Date.now()) return cached.forest
    const forest = await computeForest(workspaceId)
    cache.set(workspaceId, { forest, expires: Date.now() + FOREST_TTL_MS })
    return forest
}
