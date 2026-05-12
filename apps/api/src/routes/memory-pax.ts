// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * `memory.embeddings.*` + `memory.cluster.*` PAX HTTP endpoints.
 *
 * These are the cross-app surface that Nexalog graph, Plexo SCL, and any
 * other consumer hits over service-key auth. The existing per-workspace
 * `POST /api/v1/memory/cluster` (which recomputes Louvain on memory_themes)
 * stays unchanged — that's the synthesis pipeline's DB-backed surface, not
 * the generic primitive.
 *
 *   POST /api/v1/memory/embeddings           — embed text (single or batch)
 *   POST /api/v1/memory/cluster/compute      — cluster {id, vector}[] items
 *   POST /api/v1/memory/cluster/label        — name a cluster from contents
 *
 * Auth: `Authorization: Bearer <PLEXO_SERVICE_KEY>` + `X-App-Id`. This is
 * the same shape that Levio/Fonto/Nexalog use to talk back to Plexo.
 *
 * Error envelope: `{ error: { code, message } }` per AUDIT-P3 standard.
 */
import { Router, type Router as RouterType } from 'express'
import { embedAsArrays } from '@plexo/agent/memory/embeddings'
import { cluster, topicLabel, type ClusterItem, type ClusterMethod } from '@plexo/agent/memory/cluster-api'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { logger } from '../logger.js'

// NOTE on routing: this router is mounted at `/memory` ALONGSIDE the
// workspace-gated `memoryRouter`. We attach `requireServiceKey` per-route
// (rather than via `router.use`) so requests for paths that don't belong
// to this router fall through cleanly to the workspace-gated one without
// being intercepted by the service-key check.
export const memoryPaxRouter: RouterType = Router()

const MAX_TEXTS_PER_REQUEST = 256
const MAX_TEXT_LEN = 8192
const MAX_CLUSTER_ITEMS = 5_000
const MAX_VECTOR_DIM = 4096

interface ErrEnvelope { error: { code: string; message: string; detail?: unknown } }
function err(code: string, message: string, detail?: unknown): ErrEnvelope {
    return { error: { code, message, ...(detail !== undefined ? { detail } : {}) } }
}

/* ── POST /memory/embeddings ──────────────────────────────────────────── */

memoryPaxRouter.post('/embeddings', requireServiceKey, async (req, res) => {
    try {
        const body = (req.body ?? {}) as { texts?: unknown; workspaceId?: unknown }
        if (!Array.isArray(body.texts)) {
            return res.status(400).json(err('INVALID_INPUT', 'Body must contain a `texts` array of strings'))
        }
        if (body.texts.length === 0) {
            return res.json({ vectors: [], dimensions: 0, count: 0 })
        }
        if (body.texts.length > MAX_TEXTS_PER_REQUEST) {
            return res.status(413).json(err('TOO_MANY_TEXTS', `Max ${MAX_TEXTS_PER_REQUEST} texts per request`))
        }
        const texts: string[] = []
        for (const t of body.texts) {
            if (typeof t !== 'string') return res.status(400).json(err('INVALID_INPUT', '`texts` must be string[]'))
            texts.push(t.length > MAX_TEXT_LEN ? t.slice(0, MAX_TEXT_LEN) : t)
        }
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined
        const vectors = await embedAsArrays(texts, { workspaceId })
        const dims = vectors[0]?.length ?? 0
        return res.json({ vectors, dimensions: dims, count: vectors.length })
    } catch (e) {
        const code = (e as { code?: string })?.code === 'NO_EMBEDDER' ? 'NO_EMBEDDER' : 'INTERNAL_ERROR'
        const status = code === 'NO_EMBEDDER' ? 503 : 500
        const message = e instanceof Error ? e.message : 'Failed to embed'
        logger.warn({ err: e, appId: req.serviceContext?.appId }, 'memory-pax: embeddings failed')
        return res.status(status).json(err(code, message))
    }
})

/* ── POST /memory/cluster/compute ─────────────────────────────────────── */

memoryPaxRouter.post('/cluster/compute', requireServiceKey, async (req, res) => {
    try {
        const body = (req.body ?? {}) as {
            items?: unknown
            method?: unknown
            k?: unknown
            distanceThreshold?: unknown
            minClusterSize?: unknown
            seed?: unknown
        }
        if (!Array.isArray(body.items)) {
            return res.status(400).json(err('INVALID_INPUT', '`items` must be an array of {id, vector}'))
        }
        if (body.items.length === 0) {
            return res.json({
                assignments: [], clusters: [], noise: [], method: 'kmeans',
                chosenK: null, durationMs: 0,
            })
        }
        if (body.items.length > MAX_CLUSTER_ITEMS) {
            return res.status(413).json(err('TOO_MANY_ITEMS', `Max ${MAX_CLUSTER_ITEMS} items per request`))
        }
        const items: ClusterItem[] = []
        let dim = -1
        for (const raw of body.items) {
            if (!raw || typeof raw !== 'object') {
                return res.status(400).json(err('INVALID_INPUT', 'Each item must be {id, vector}'))
            }
            const r = raw as { id?: unknown; vector?: unknown }
            if (typeof r.id !== 'string' || !r.id) {
                return res.status(400).json(err('INVALID_INPUT', 'Each item must have a string id'))
            }
            if (!Array.isArray(r.vector)) {
                return res.status(400).json(err('INVALID_INPUT', 'Each item.vector must be a number array'))
            }
            if (r.vector.length === 0 || r.vector.length > MAX_VECTOR_DIM) {
                return res.status(400).json(err('INVALID_INPUT', `Vector dim must be 1..${MAX_VECTOR_DIM}`))
            }
            if (dim === -1) dim = r.vector.length
            else if (dim !== r.vector.length) {
                return res.status(400).json(err('INVALID_INPUT', 'All vectors must share dimensionality'))
            }
            const arr = new Array<number>(r.vector.length)
            for (let i = 0; i < r.vector.length; i++) {
                const n = Number(r.vector[i])
                if (!Number.isFinite(n)) return res.status(400).json(err('INVALID_INPUT', 'Vectors must be finite numbers'))
                arr[i] = n
            }
            items.push({ id: r.id, vector: arr })
        }

        const method: ClusterMethod | undefined = typeof body.method === 'string'
            ? (body.method as ClusterMethod)
            : undefined
        if (method && method !== 'kmeans' && method !== 'agglomerative' && method !== 'hdbscan') {
            return res.status(400).json(err('INVALID_INPUT', "method must be 'kmeans' | 'agglomerative' | 'hdbscan'"))
        }

        const result = await cluster(items, {
            method,
            k: typeof body.k === 'number' ? body.k : undefined,
            distanceThreshold: typeof body.distanceThreshold === 'number' ? body.distanceThreshold : undefined,
            minClusterSize: typeof body.minClusterSize === 'number' ? body.minClusterSize : undefined,
            seed: typeof body.seed === 'number' ? body.seed : undefined,
        })
        return res.json(result)
    } catch (e) {
        const code = (e as { code?: string })?.code === 'METHOD_NOT_IMPLEMENTED' ? 'METHOD_NOT_IMPLEMENTED' : 'INTERNAL_ERROR'
        const status = code === 'METHOD_NOT_IMPLEMENTED' ? 501 : 500
        logger.warn({ err: e, appId: req.serviceContext?.appId }, 'memory-pax: cluster/compute failed')
        return res.status(status).json(err(code, e instanceof Error ? e.message : 'Cluster failed'))
    }
})

/* ── POST /memory/cluster/label ───────────────────────────────────────── */

memoryPaxRouter.post('/cluster/label', requireServiceKey, async (req, res) => {
    try {
        const body = (req.body ?? {}) as { contents?: unknown; corpus?: unknown; workspaceId?: unknown }
        if (!Array.isArray(body.contents)) {
            return res.status(400).json(err('INVALID_INPUT', '`contents` must be a string array'))
        }
        if (body.contents.length === 0) {
            return res.json({ label: 'Empty cluster', summary: '', source: 'ctfidf' })
        }
        const contents: string[] = []
        for (const c of body.contents) {
            if (typeof c !== 'string') return res.status(400).json(err('INVALID_INPUT', '`contents` must be string[]'))
            contents.push(c.length > MAX_TEXT_LEN ? c.slice(0, MAX_TEXT_LEN) : c)
        }
        const corpus: string[] | undefined = Array.isArray(body.corpus)
            ? body.corpus.filter((s): s is string => typeof s === 'string').map(s => s.slice(0, MAX_TEXT_LEN))
            : undefined
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined
        const out = await topicLabel({ contents, corpus, workspaceId })
        return res.json(out)
    } catch (e) {
        logger.warn({ err: e, appId: req.serviceContext?.appId }, 'memory-pax: cluster/label failed')
        return res.status(500).json(err('INTERNAL_ERROR', e instanceof Error ? e.message : 'Label failed'))
    }
})
