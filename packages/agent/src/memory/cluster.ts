// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory clustering — Phase 1 of the unified Knowledge Graph + SCL system.
 *
 * Replaces the prior O(n²) agglomerative-cosine loop with multi-resolution
 * Louvain community detection over a precomputed kNN graph. The plan calls
 * this "Leiden" but `graphology-communities-leiden` does not exist in the
 * npm ecosystem — only `graphology-communities-louvain` ships. Louvain at
 * three different `resolution` (γ) values gives us a hierarchy that's
 * functionally equivalent for our scale (~700 entries today, headroom for
 * ~10k); upgrade to the C bindings of `igraph` if/when we need Leiden's
 * connectivity guarantees.
 *
 * Three resolution passes produce a 3-level hierarchy:
 *
 *   level 0 — region    γ=0.6   coarse buckets (≈ 5–15 per workspace)
 *   level 1 — theme     γ=1.0   the level Phase α already used
 *   level 2 — subtheme  γ=1.6   fine-grained slices inside a theme
 *
 * Members get UMAP-2D coordinates persisted on memory_entries.metadata.umap
 * so the forest endpoint can render them without recomputing the projection.
 *
 * Stable IDs are assigned by greedy member-set Jaccard ≥ 0.6 against the
 * previous run; matched themes reuse the prior `id` and `stable_id` so
 * downstream UI doesn't churn.
 *
 * The legacy ClusterMemoryResult shape (clusters[], noise[]) is preserved so
 * existing callers keep working — but now those clusters are the level=1
 * themes, and the route also persists levels 0 and 2 underneath.
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'
import { callModel } from '../providers/call-model.js'
import { resolveModel, resolveModelFromEnv, type AnyLanguageModel } from '../providers/registry.js'
import { loadSettingsFromInstances } from '../providers/settings-from-instances.js'
import { refreshKnnEdges, readKnnEdges } from './knn.js'

const logger = pino({ name: 'memory-cluster' })

const ALGO_VERSION = 'louvain-multires+umap.v1'

const DEFAULT_MIN_CLUSTER_SIZE = 4
const DEFAULT_COHERENCE_FLOOR = 0.74

const RESOLUTIONS = [
    { level: 0 as const, gamma: 0.6, label: 'region' },
    { level: 1 as const, gamma: 1.0, label: 'theme' },
    { level: 2 as const, gamma: 1.6, label: 'subtheme' },
]

const STABLE_ID_JACCARD_FLOOR = 0.6

export interface ClusteredMemory {
    /** Filled by route once persisted. */
    id: string
    label: string
    memberIds: string[]
    /** Mean of unit vectors of members. */
    centroid: number[]
    coherence: number
    /** Hierarchy level — 0=region, 1=theme, 2=subtheme. */
    level: 0 | 1 | 2
    /** Parent's index in the next-coarser level array. The route translates
     *  this into the parent_id UUID once that row is persisted. */
    parentIdx?: number
    /** Stable identifier reused across runs when member-set Jaccard ≥ 0.6. */
    stableId: string
    /** UUID of the prior-run row that we matched into; set when an existing
     *  theme is reused (so the route can UPDATE in place rather than INSERT). */
    matchedPriorId?: string
}

export interface ClusterMemoryResult {
    /** All themes across all levels. Level 1 is the legacy "themes" surface. */
    clusters: ClusteredMemory[]
    /** Member ids that ended up in a community of size < minClusterSize at level 1. */
    noise: string[]
    /** Per-level summary used by the route + run-history insert. */
    summary: { level: 0 | 1 | 2; count: number }[]
    /** memberId → {x, y} computed once via UMAP and persisted on the entry. */
    umap: Record<string, { x: number; y: number }>
    /** Run wall-clock used for memory_theme_runs insert. */
    durationMs: number
    algoVersion: string
}

interface RawEntry {
    id: string
    content: string
    embedding: number[]
}

/* ────── helpers ────── */

function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0
    const len = a.length
    for (let i = 0; i < len; i++) {
        const x = a[i] ?? 0
        const y = b[i] ?? 0
        dot += x * y
        na += x * x
        nb += y * y
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom === 0 ? 0 : dot / denom
}

function meanUnitVector(vecs: number[][]): number[] {
    if (vecs.length === 0) return []
    const len = vecs[0]!.length
    const out = new Array<number>(len).fill(0)
    for (const v of vecs) {
        let n = 0
        for (let i = 0; i < len; i++) n += (v[i] ?? 0) * (v[i] ?? 0)
        const norm = Math.sqrt(n) || 1
        for (let i = 0; i < len; i++) out[i]! += (v[i] ?? 0) / norm
    }
    for (let i = 0; i < len; i++) out[i]! /= vecs.length
    return out
}

function meanIntraCosine(vecs: number[][]): number {
    if (vecs.length < 2) return 1
    let sum = 0, n = 0
    for (let i = 0; i < vecs.length; i++) {
        for (let j = i + 1; j < vecs.length; j++) {
            sum += cosine(vecs[i]!, vecs[j]!)
            n++
        }
    }
    return n === 0 ? 1 : sum / n
}

function parseVector(raw: unknown): number[] | null {
    if (raw == null) return null
    if (Array.isArray(raw)) return raw as number[]
    if (typeof raw !== 'string') return null
    const t = raw.trim().replace(/^\[/, '').replace(/\]$/, '')
    if (!t) return null
    const parts = t.split(',')
    const out = new Array<number>(parts.length)
    for (let i = 0; i < parts.length; i++) {
        const n = Number(parts[i])
        if (!Number.isFinite(n)) return null
        out[i] = n
    }
    return out
}

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for',
    'with', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'i', 'we', 'you',
    'they', 'he', 'she', 'it', 'this', 'that', 'these', 'those', 'as', 'at', 'by',
    'from', 'so', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would',
    'should', 'could', 'can', 'may', 'might', 'about', 'into', 'than', 'then',
    'there', 'here', 'just', 'not', 'no', 'yes', 'my', 'your', 'our', 'their',
    'me', 'us', 'them', 'him', 'her', 'his', 'its', 'one', 'two', 'three',
])

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 4 && !STOPWORDS.has(t))
}

function ctfidfLabel(memberContents: string[], allCorpusContents: string[]): string {
    const clusterTf = new Map<string, number>()
    for (const c of memberContents) {
        for (const t of tokenize(c)) clusterTf.set(t, (clusterTf.get(t) ?? 0) + 1)
    }
    const docFreq = new Map<string, number>()
    for (const c of allCorpusContents) {
        const seen = new Set<string>()
        for (const t of tokenize(c)) {
            if (!seen.has(t)) {
                docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
                seen.add(t)
            }
        }
    }
    const N = Math.max(1, allCorpusContents.length)
    let bestTerm: string | null = null
    let bestScore = -Infinity
    for (const [term, tf] of clusterTf.entries()) {
        const df = docFreq.get(term) ?? 1
        const idf = Math.log(N / df)
        const score = tf * idf
        if (score > bestScore) {
            bestScore = score
            bestTerm = term
        }
    }
    if (bestTerm) return bestTerm.charAt(0).toUpperCase() + bestTerm.slice(1)
    for (const c of memberContents) {
        const toks = tokenize(c)
        if (toks[0]) return toks[0].charAt(0).toUpperCase() + toks[0].slice(1)
    }
    return 'Theme'
}

async function llmLabel(workspaceId: string, memberContents: string[]): Promise<string | null> {
    try {
        const settings = await loadSettingsFromInstances(workspaceId)
        let model: AnyLanguageModel | null = null
        let providerKey = 'env'
        if (settings) {
            try {
                const r = await resolveModel('summarization', settings, workspaceId)
                model = r.model
                providerKey = r.meta.provider
            } catch (err) {
                logger.warn({ err, workspaceId }, 'cluster.llmLabel: resolveModel failed — env fallback')
            }
        }
        if (!model) {
            try {
                model = resolveModelFromEnv()
                providerKey = 'env'
            } catch (err) {
                logger.warn({ err, workspaceId }, 'cluster.llmLabel: env resolve failed — null label')
                return null
            }
        }
        const sample = memberContents.slice(0, 12).map(c => `- ${c.slice(0, 120).replace(/\s+/g, ' ').trim()}`).join('\n')
        const { text } = await callModel({
            model: model!,
            provider: providerKey,
            system: 'You are a concise label generator. Reply with ONLY the label text — no quotes, no period, no preamble, no explanation.',
            messages: [{ role: 'user', content: `Summarize the common idea connecting these ${memberContents.length} items in <=42 chars, no quotes, no period:\n${sample}` }],
            maxTokens: 32,
        })
        const cleaned = (text ?? '').trim().replace(/^["'`]+|["'`.]+$/g, '').split('\n')[0]!.slice(0, 42).trim()
        return cleaned || null
    } catch (err) {
        logger.warn({ err, workspaceId }, 'cluster.llmLabel failed — c-TF-IDF fallback')
        return null
    }
}

/* ────── Louvain adapter ────── */

interface LouvainInput {
    nodes: string[]
    edges: Array<{ aId: string; bId: string; weight: number }>
}

/**
 * Run Louvain once at a given resolution. Returns a per-node community id.
 *
 * The graphology-communities-louvain API exposes a function `louvain(graph, opts)`
 * that returns either a flat node→community map or `{communities: …}`. We handle
 * both shapes defensively because the package has bumped the contract before.
 */
async function runLouvainOnce(input: LouvainInput, gamma: number): Promise<Map<string, number>> {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const Graph = (await import('graphology')).default as any
    const louvainMod: any = await import('graphology-communities-louvain')
    const louvain = louvainMod.default ?? louvainMod
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const g = new Graph({ type: 'undirected', allowSelfLoops: false, multi: false })
    for (const id of input.nodes) g.addNode(id)
    for (const e of input.edges) {
        if (e.aId === e.bId) continue
        if (!g.hasNode(e.aId) || !g.hasNode(e.bId)) continue
        if (g.hasEdge(e.aId, e.bId)) {
            const edgeKey = g.edge(e.aId, e.bId)
            const cur = g.getEdgeAttribute(edgeKey, 'weight') as number | undefined
            g.setEdgeAttribute(edgeKey, 'weight', Math.max(cur ?? 0, e.weight))
            continue
        }
        g.addEdge(e.aId, e.bId, { weight: e.weight })
    }

    const partition = louvain(g, { resolution: gamma, getEdgeWeight: 'weight' })

    const out = new Map<string, number>()
    if (partition && typeof partition === 'object') {
        const flat: Record<string, number> = ((partition as Record<string, unknown>).communities ?? partition) as Record<string, number>
        for (const [nodeId, community] of Object.entries(flat)) out.set(nodeId, community as number)
    }
    let nextId = (out.size > 0 ? Math.max(...Array.from(out.values())) : 0) + 1
    for (const id of input.nodes) {
        if (!out.has(id)) out.set(id, nextId++)
    }
    return out
}

/* ────── UMAP ────── */

async function computeUmap(entries: RawEntry[]): Promise<Record<string, { x: number; y: number }>> {
    if (entries.length === 0) return {}
    if (entries.length < 4) {
        const out: Record<string, { x: number; y: number }> = {}
        for (const e of entries) out[e.id] = { x: 0, y: 0 }
        return out
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const umapMod: any = await import('umap-js')
    const UMAP = umapMod.UMAP ?? umapMod.default?.UMAP ?? umapMod.default
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const data = entries.map(e => e.embedding)
    const nNeighbors = Math.min(15, Math.max(2, entries.length - 1))
    const reducer = new UMAP({ nComponents: 2, nNeighbors, minDist: 0.1, spread: 1.0 })
    const projected = reducer.fit(data) as number[][]
    const out: Record<string, { x: number; y: number }> = {}
    for (let i = 0; i < entries.length; i++) {
        const id = entries[i]!.id
        out[id] = { x: projected[i]?.[0] ?? 0, y: projected[i]?.[1] ?? 0 }
    }
    return out
}

/* ────── community → ClusteredMemory ────── */

interface RawCommunity {
    members: number[]   // indices into entries[]
}

function communitiesByLevel(
    entries: RawEntry[],
    partition: Map<string, number>,
): RawCommunity[] {
    const byCommunity = new Map<number, number[]>()
    for (let i = 0; i < entries.length; i++) {
        const id = entries[i]!.id
        const cid = partition.get(id)
        if (cid == null) continue
        const list = byCommunity.get(cid)
        if (list) list.push(i)
        else byCommunity.set(cid, [i])
    }
    return Array.from(byCommunity.values()).map(members => ({ members }))
}

/* ────── stable id resolution ────── */

interface PriorTheme {
    id: string
    stableId: string | null
    memberIds: string[]
}

function jaccard(a: Set<string>, b: Set<string>): number {
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    const union = a.size + b.size - inter
    return union === 0 ? 0 : inter / union
}

async function loadPriorThemes(workspaceId: string, level: 0 | 1 | 2): Promise<PriorTheme[]> {
    const rows = Array.from(await db.execute<{ id: string; stable_id: string | null; member_ids: string[] }>(sql`
        SELECT id, stable_id, member_ids
        FROM memory_themes
        WHERE workspace_id = ${workspaceId}::uuid
          AND level = ${level}
    `))
    return rows.map(r => ({ id: r.id, stableId: r.stable_id, memberIds: r.member_ids ?? [] }))
}

/** Greedy match: for each new cluster (largest first), pick the unused
 *  prior with max Jaccard ≥ 0.6. */
function assignStableIds(
    newClusters: ClusteredMemory[],
    priors: PriorTheme[],
): void {
    const usedPriorIds = new Set<string>()
    const newSets = newClusters.map(c => new Set(c.memberIds))
    const priorSets = priors.map(p => new Set(p.memberIds))

    const order = newClusters
        .map((c, i) => ({ i, size: c.memberIds.length }))
        .sort((a, b) => b.size - a.size)
        .map(x => x.i)

    for (const i of order) {
        let bestJ = -1
        let bestScore = STABLE_ID_JACCARD_FLOOR
        for (let j = 0; j < priors.length; j++) {
            const p = priors[j]!
            if (usedPriorIds.has(p.id)) continue
            const score = jaccard(newSets[i]!, priorSets[j]!)
            if (score >= bestScore) {
                bestScore = score
                bestJ = j
            }
        }
        if (bestJ >= 0) {
            const matched = priors[bestJ]!
            usedPriorIds.add(matched.id)
            newClusters[i]!.stableId = matched.stableId ?? matched.id
            newClusters[i]!.matchedPriorId = matched.id
        } else {
            newClusters[i]!.stableId = `t_${crypto.randomUUID().slice(0, 12)}`
        }
    }
}

/* ────── parent assignment ────── */

function assignParents(
    children: ClusteredMemory[],
    parents: ClusteredMemory[],
): void {
    if (parents.length === 0) return
    const parentSets = parents.map(p => new Set(p.memberIds))
    for (let i = 0; i < children.length; i++) {
        const childSet = new Set(children[i]!.memberIds)
        let bestIdx = 0
        let bestOverlap = -1
        for (let j = 0; j < parents.length; j++) {
            let inter = 0
            for (const m of childSet) if (parentSets[j]!.has(m)) inter++
            if (inter > bestOverlap) {
                bestOverlap = inter
                bestIdx = j
            }
        }
        children[i]!.parentIdx = bestIdx
    }
}

/* ────── main ────── */

export async function clusterMemory(
    workspaceId: string,
    opts?: { minClusterSize?: number; coherenceFloor?: number },
): Promise<ClusterMemoryResult> {
    const t0 = Date.now()
    const minClusterSize = opts?.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE
    const coherenceFloor = opts?.coherenceFloor ?? DEFAULT_COHERENCE_FLOOR

    // 1) Refresh kNN edges. Doing this inside cluster keeps the route's
    //    contract simple (one POST, fully consistent output).
    await refreshKnnEdges(workspaceId)

    // 2) Load embedded entries.
    const rows = Array.from(await db.execute<{ id: string; content: string; embedding: string | null }>(sql`
        SELECT id, content, embedding::text AS embedding
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND embedding IS NOT NULL
        ORDER BY created_at ASC
    `))
    const entries: RawEntry[] = []
    for (const r of rows) {
        const v = parseVector(r.embedding)
        if (!v || v.length === 0) continue
        entries.push({ id: r.id, content: r.content, embedding: v })
    }

    if (entries.length === 0) {
        return {
            clusters: [], noise: [],
            summary: [{ level: 0, count: 0 }, { level: 1, count: 0 }, { level: 2, count: 0 }],
            umap: {},
            durationMs: Date.now() - t0,
            algoVersion: ALGO_VERSION,
        }
    }

    const allContents = entries.map(e => e.content)
    const nodeIds = entries.map(e => e.id)

    // 3) Load kNN edges once; reuse across all three Louvain passes.
    const edges = await readKnnEdges(workspaceId)

    // 4) Run Louvain at each γ and turn communities into ClusteredMemory[].
    const perLevel: ClusteredMemory[][] = [[], [], []]
    for (const { level, gamma } of RESOLUTIONS) {
        const partition = await runLouvainOnce({ nodes: nodeIds, edges }, gamma)
        const communities = communitiesByLevel(entries, partition)
        const out: ClusteredMemory[] = []

        for (const c of communities) {
            if (c.members.length < minClusterSize) continue
            const memberIds = c.members.map(k => entries[k]!.id).sort()
            const memberVecs = c.members.map(k => entries[k]!.embedding)
            const memberContents = c.members.map(k => entries[k]!.content)
            const coherence = meanIntraCosine(memberVecs)

            // Coherence gate enforced at level=1 only (the surface that
            // gates promotion). Levels 0 and 2 are organisational and may
            // include looser groupings; coherence is still recorded.
            if (level === 1 && coherence < coherenceFloor) continue

            let label = await llmLabel(workspaceId, memberContents)
            if (!label) label = ctfidfLabel(memberContents, allContents)

            out.push({
                id: '',
                label,
                memberIds,
                centroid: meanUnitVector(memberVecs),
                coherence,
                level,
                stableId: '',
            })
        }

        out.sort((a, b) => b.memberIds.length - a.memberIds.length || (a.memberIds[0] ?? '').localeCompare(b.memberIds[0] ?? ''))
        perLevel[level] = out
    }

    // 5) Assign parents: theme→region, subtheme→theme.
    assignParents(perLevel[1]!, perLevel[0]!)
    assignParents(perLevel[2]!, perLevel[1]!)

    // 6) Stable IDs: per-level Jaccard match to prior run.
    for (const { level } of RESOLUTIONS) {
        const priors = await loadPriorThemes(workspaceId, level)
        assignStableIds(perLevel[level]!, priors)
    }

    // 7) UMAP-2D for all members. One reducer over the whole corpus —
    //    much more useful than per-cluster projections because users
    //    will see the whole space at once.
    const umap = await computeUmap(entries)

    // 8) Compose noise list (entries with no level-1 community), then
    //    flatten all levels into the result.
    const level1 = perLevel[1]!
    const level1Members = new Set<string>()
    for (const c of level1) for (const m of c.memberIds) level1Members.add(m)
    const noise: string[] = []
    for (const e of entries) if (!level1Members.has(e.id)) noise.push(e.id)

    const allClusters = [...perLevel[0]!, ...perLevel[1]!, ...perLevel[2]!]
    const summary = RESOLUTIONS.map(r => ({ level: r.level, count: perLevel[r.level]!.length }))
    const durationMs = Date.now() - t0

    logger.info({ workspaceId, nEntries: entries.length, summary, durationMs }, 'clusterMemory complete (Louvain multires + UMAP)')

    return {
        clusters: allClusters,
        noise,
        summary,
        umap,
        durationMs,
        algoVersion: ALGO_VERSION,
    }
}
