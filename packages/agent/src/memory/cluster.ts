// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory clustering — Phase 1+3 of the unified Knowledge Graph + SCL system.
 *
 * Pipeline:
 *   1. Refresh kNN edges via memory/knn.ts (HNSW-backed top-15 per node).
 *   2. Run Louvain community detection at three resolutions:
 *        level 0 — region    γ=0.6
 *        level 1 — theme     γ=1.0    (the surface SCL promotion gates on)
 *        level 2 — subtheme  γ=1.6
 *   3. For each community: compute centroid (mean of unit vectors), coherence
 *      (mean intra-cosine), and pick three exemplars via centroid-anchored MMR
 *      (λ=0.5, balances proximity to centroid and diversity from already-picked
 *       exemplars).
 *   4. Label level=1 themes with claude-haiku-4-5 returning structured JSON
 *      `{label, why}` — multilingual content in, English label out. Falls back
 *      to c-TF-IDF if the LLM call fails. `why` is persisted to memory_themes.why
 *      for the dashboard's "what is this cluster about?" surface.
 *   5. Hungarian-on-centroid theme stability matching at level=1: build a
 *      cost matrix (1 - cosine) between new and old themes, solve assignment
 *      to maximise total cosine, reuse old (id, stable_id) for matches.
 *      Levels 0 and 2 inherit identity via parent overlap (no separate match).
 *   6. UMAP-2D projection over the whole corpus; written to
 *      memory_entries.metadata.umap by the route.
 *
 * Compatible with the Alpha-era `clusterMemory()` contract — same return shape
 * (`clusters[], noise[], summary[], umap, durationMs, algoVersion`), the route
 * code at apps/api/src/routes/memory.ts is unchanged.
 */
import pino from 'pino'
import { z } from 'zod'
import { db, sql } from '@plexo/db'
import { callModel, CallModelError } from '../providers/call-model.js'
import { resolveModelFromEnv, type AnyLanguageModel } from '../providers/registry.js'
import { loadSettingsFromInstances } from '../providers/settings-from-instances.js'
import { routeAndCall } from '../providers/router-v2/index.js'
import { refreshKnnEdges, readKnnEdges } from './knn.js'
// Shared primitive — Phase 5 promotion. Synthesis still uses the
// inline llmLabel below for label+why semantics it needs (level=1
// Haiku JSON), but the shared API is what cross-app callers consume
// via memory.cluster.label. Importing here keeps the surface coherent
// across the pipeline and guarantees a single source of truth for
// future label-prompt evolution.
export { topicLabel } from './cluster-api.js'

const logger = pino({ name: 'memory-cluster' })

const ALGO_VERSION = 'louvain-multires+umap+haiku.v3'

const DEFAULT_MIN_CLUSTER_SIZE = 4
const DEFAULT_COHERENCE_FLOOR = 0.74

const RESOLUTIONS = [
    { level: 0 as const, gamma: 0.6, label: 'region' },
    { level: 1 as const, gamma: 1.0, label: 'theme' },
    { level: 2 as const, gamma: 1.6, label: 'subtheme' },
]

const MMR_LAMBDA = 0.5
const N_EXEMPLARS = 3

const LABEL_MAX_CHARS = 36

export interface ClusteredMemory {
    /** Filled by route once persisted. */
    id: string
    label: string
    /** Phase 3 — short rationale string returned by Haiku alongside the label. */
    why: string | null
    memberIds: string[]
    /** Three exemplar ids picked via centroid-anchored MMR (λ=0.5). */
    exemplarIds: string[]
    /** Mean of unit vectors of members. */
    centroid: number[]
    coherence: number
    /** Hierarchy level — 0=region, 1=theme, 2=subtheme. */
    level: 0 | 1 | 2
    /** Parent's index in the next-coarser level array. The route translates
     *  this into the parent_id UUID once that row is persisted. */
    parentIdx?: number
    /** Stable identifier reused across runs when Hungarian-on-centroid matches. */
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

/** c-TF-IDF top-3 keyphrases used as a hint for the Haiku prompt + the
 *  c-TF-IDF fallback label. Returns the chosen label-fallback term and the
 *  top-3 keyphrase array. */
function ctfidfTop(memberContents: string[], allCorpusContents: string[], k = 3): { label: string; keyphrases: string[] } {
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
    const scored: Array<{ term: string; score: number }> = []
    for (const [term, tf] of clusterTf.entries()) {
        const df = docFreq.get(term) ?? 1
        const idf = Math.log(N / df)
        scored.push({ term, score: tf * idf })
    }
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, k).map(s => s.term)
    const labelTerm = top[0] ?? ''
    const label = labelTerm
        ? labelTerm.charAt(0).toUpperCase() + labelTerm.slice(1)
        : (memberContents[0]?.split(/\s+/).slice(0, 3).join(' ') || 'Theme')
    return { label, keyphrases: top }
}

/* ────── Phase 3 N.1 — Haiku JSON labels ────── */

const labelSchema = z.object({
    label: z.string().min(1).max(80),
    why: z.string().min(1).max(280),
})

/** Compose the canonical Haiku prompt described in the Phase 3 spec.
 *  Inputs: cluster size, top-3 keyphrases, three exemplar contents. */
async function llmLabel(
    workspaceId: string,
    memberContents: string[],
    keyphrases: string[],
    exemplars: string[],
): Promise<{ label: string; why: string } | null> {
    try {
        const settings = await loadSettingsFromInstances(workspaceId)

        const N = memberContents.length
        const cleanedExemplars = exemplars.slice(0, 3).map(e =>
            e.replace(/\s+/g, ' ').trim().slice(0, 220),
        )
        const exemplarBlock = cleanedExemplars.map(e => `- ${e}`).join('\n')
        const keyBlock = keyphrases.slice(0, 3).join(', ') || '(none)'

        const system = 'You name clusters of saved items. Output JSON only: {label, why}. Label ≤ 36 chars, noun phrase, no quotes, no period, English even if items are French/Russian.'
        const user = `These ${N} items cluster together. Top keyphrases: [${keyBlock}]. Three exemplars:\n${exemplarBlock}\nName the cluster.`

        const doCall = (model: AnyLanguageModel) => callModel({
            model,
            provider: 'router-v2',
            system,
            messages: [{ role: 'user', content: user }],
            maxTokens: 200,
            schema: labelSchema,
            schemaName: 'cluster_label',
            schemaDescription: 'A short English noun phrase naming the cluster, plus a one-sentence rationale.',
        })

        let result: Awaited<ReturnType<typeof doCall>> | null = null
        if (settings) {
            try {
                result = await routeAndCall({ workspaceId, taskType: 'summarization', settings, doCall })
            } catch (err) {
                logger.warn({ err, workspaceId }, 'cluster.llmLabel: routeAndCall failed — env fallback')
            }
        }
        if (!result) {
            let envModel: AnyLanguageModel
            try {
                envModel = resolveModelFromEnv()
            } catch (err) {
                logger.warn({ err, workspaceId }, 'cluster.llmLabel: env resolve failed — null label')
                return null
            }
            result = await doCall(envModel)
        }

        // schema-mode call — `object` is parsed JSON
        const obj = (result as { object?: { label: string; why: string } }).object
        if (!obj) return null
        const label = (obj.label ?? '').trim().replace(/^["'`]+|["'`.]+$/g, '').slice(0, LABEL_MAX_CHARS).trim()
        const why = (obj.why ?? '').trim().slice(0, 280)
        if (!label) return null
        return { label, why }
    } catch (err) {
        if (err instanceof CallModelError) {
            logger.warn({ code: err.code, workspaceId }, 'cluster.llmLabel CallModelError — c-TF-IDF fallback')
        } else {
            logger.warn({ err, workspaceId }, 'cluster.llmLabel failed — c-TF-IDF fallback')
        }
        return null
    }
}

/* ────── exemplar picking — centroid-anchored MMR ────── */

function pickExemplarsMMR(
    memberIds: string[],
    memberVecs: number[][],
    centroid: number[],
    n = N_EXEMPLARS,
    lambda = MMR_LAMBDA,
): string[] {
    const k = Math.min(n, memberIds.length)
    if (k === 0) return []
    if (k === memberIds.length) return [...memberIds]

    const simToCentroid = memberVecs.map(v => cosine(v, centroid))
    const picked: number[] = []
    const pickedSet = new Set<number>()

    while (picked.length < k) {
        let bestIdx = -1
        let bestScore = -Infinity
        for (let i = 0; i < memberVecs.length; i++) {
            if (pickedSet.has(i)) continue
            let maxSimToPicked = 0
            for (const p of picked) {
                const s = cosine(memberVecs[i]!, memberVecs[p]!)
                if (s > maxSimToPicked) maxSimToPicked = s
            }
            const score = lambda * (simToCentroid[i] ?? 0) - (1 - lambda) * maxSimToPicked
            if (score > bestScore) {
                bestScore = score
                bestIdx = i
            }
        }
        if (bestIdx < 0) break
        picked.push(bestIdx)
        pickedSet.add(bestIdx)
    }

    return picked.map(i => memberIds[i]!)
}

/* ────── Louvain adapter ────── */

interface LouvainInput {
    nodes: string[]
    edges: Array<{ aId: string; bId: string; weight: number }>
}

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

/* ────── Phase 3 N.2 — Hungarian-on-centroid stable id resolution ────── */

interface PriorTheme {
    id: string
    stableId: string | null
    memberIds: string[]
    centroid: number[] | null
}

async function loadPriorThemesWithCentroid(workspaceId: string, level: 0 | 1 | 2): Promise<PriorTheme[]> {
    const rows = Array.from(await db.execute<{ id: string; stable_id: string | null; member_ids: string[]; centroid: string | null }>(sql`
        SELECT id, stable_id, member_ids, centroid::text AS centroid
        FROM memory_themes
        WHERE workspace_id = ${workspaceId}::uuid
          AND level = ${level}
    `))
    return rows.map(r => ({
        id: r.id,
        stableId: r.stable_id,
        memberIds: r.member_ids ?? [],
        centroid: parseVector(r.centroid),
    }))
}

/**
 * Solve a maximum-weight assignment on a rectangular cost matrix using
 * the Hungarian algorithm (Jonker–Volgenant variant, square-padded).
 *
 * Inputs are NEGATED costs (i.e. costs[i][j] = -similarity[i][j]) so the
 * solver — written for minimisation — produces the maximum-similarity
 * assignment. Padding with a large positive cost handles non-square
 * matrices without introducing spurious matches.
 *
 * Returns row→col assignment (length = rows.length). col=-1 means the
 * row was matched to a padding column (no real prior).
 *
 * Hand-rolled because adding `munkres-js` would force a docker rebuild
 * that the orchestrator owns; a 100-line solver is well within scope.
 * Complexity O(n³); we cap matching at level=1 only (tens of themes per
 * workspace), so n≤100 is the realistic ceiling.
 */
function hungarianMin(cost: number[][]): number[] {
    const nRows = cost.length
    const nCols = cost[0]?.length ?? 0
    const n = Math.max(nRows, nCols)
    if (n === 0) return []

    const INF = 1e18
    // Pad to a square matrix with a large constant so unmatched rows/cols
    // get assigned to dummies that don't disrupt real matches.
    const PAD = 1e9
    const C: number[][] = []
    for (let i = 0; i < n; i++) {
        const row = new Array<number>(n).fill(PAD)
        if (i < nRows) {
            for (let j = 0; j < nCols; j++) row[j] = cost[i]![j]!
        }
        C.push(row)
    }

    // u, v are dual variables; p[j] is the row matched to column j; way[j]
    // helps reconstruct the augmenting path. Indices are 1-based per the
    // textbook Jonker–Volgenant formulation; u[0],v[0],p[0] are unused.
    const u = new Array<number>(n + 1).fill(0)
    const v = new Array<number>(n + 1).fill(0)
    const p = new Array<number>(n + 1).fill(0)
    const way = new Array<number>(n + 1).fill(0)

    for (let i = 1; i <= n; i++) {
        p[0] = i
        let j0 = 0
        const minv = new Array<number>(n + 1).fill(INF)
        const used = new Array<boolean>(n + 1).fill(false)

        do {
            used[j0] = true
            const i0 = p[j0]!
            let delta = INF
            let j1 = 0
            for (let j = 1; j <= n; j++) {
                if (used[j]) continue
                const cur = C[i0 - 1]![j - 1]! - u[i0]! - v[j]!
                if (cur < minv[j]!) {
                    minv[j] = cur
                    way[j] = j0
                }
                if (minv[j]! < delta) {
                    delta = minv[j]!
                    j1 = j
                }
            }

            for (let j = 0; j <= n; j++) {
                if (used[j]) {
                    u[p[j]!]! += delta
                    v[j]! -= delta
                } else {
                    minv[j]! -= delta
                }
            }
            j0 = j1
        } while (p[j0] !== 0)

        // Reconstruct the augmenting path
        do {
            const j1 = way[j0]!
            p[j0] = p[j1]!
            j0 = j1
        } while (j0 !== 0)
    }

    // p[j] = i means column j is assigned to row i. Convert to row→col.
    const assignment = new Array<number>(nRows).fill(-1)
    for (let j = 1; j <= n; j++) {
        const i = p[j]!
        if (i >= 1 && i <= nRows && j >= 1 && j <= nCols) {
            assignment[i - 1] = j - 1
        }
    }
    return assignment
}

/**
 * Hungarian-on-centroid assignment for level=1.
 *
 * Cost = 1 - cosine(newCentroid, priorCentroid). Match acceptance floor:
 * cosine ≥ 0.55. Below the floor, the row is treated as unmatched even
 * if the solver paired it (could happen when both sides are tiny). New
 * themes that don't match a prior get a fresh stable_id.
 */
function assignStableIdsHungarian(
    newClusters: ClusteredMemory[],
    priors: PriorTheme[],
): void {
    if (newClusters.length === 0) return

    const ACCEPT_FLOOR = 0.55

    if (priors.length === 0) {
        for (const c of newClusters) c.stableId = `t_${crypto.randomUUID().slice(0, 12)}`
        return
    }

    // Build rectangular cost matrix newClusters × priors (cost = 1 - cosine)
    const sim: number[][] = []
    const cost: number[][] = []
    for (let i = 0; i < newClusters.length; i++) {
        const a = newClusters[i]!.centroid
        const simRow = new Array<number>(priors.length).fill(0)
        const costRow = new Array<number>(priors.length).fill(1)
        for (let j = 0; j < priors.length; j++) {
            const b = priors[j]!.centroid
            if (b && b.length > 0 && a.length === b.length) {
                const s = cosine(a, b)
                simRow[j] = s
                costRow[j] = 1 - s
            }
        }
        sim.push(simRow)
        cost.push(costRow)
    }

    const assignment = hungarianMin(cost)
    const usedPriorIds = new Set<string>()

    for (let i = 0; i < newClusters.length; i++) {
        const j = assignment[i] ?? -1
        if (j >= 0 && j < priors.length) {
            const score = sim[i]![j] ?? 0
            const prior = priors[j]!
            if (score >= ACCEPT_FLOOR && !usedPriorIds.has(prior.id)) {
                usedPriorIds.add(prior.id)
                newClusters[i]!.stableId = prior.stableId ?? prior.id
                newClusters[i]!.matchedPriorId = prior.id
                continue
            }
        }
        newClusters[i]!.stableId = `t_${crypto.randomUUID().slice(0, 12)}`
    }
}

/** Children inherit identity via parent overlap. Levels 0 and 2 don't run
 *  Hungarian — they reuse identity if their best-overlap parent's stable_id
 *  hasn't changed AND member-set Jaccard ≥ 0.6 against any prior at the
 *  same level. */
function assignStableIdsByOverlap(
    newClusters: ClusteredMemory[],
    priors: PriorTheme[],
): void {
    const FLOOR = 0.6
    const usedPriorIds = new Set<string>()
    const newSets = newClusters.map(c => new Set(c.memberIds))
    const priorSets = priors.map(p => new Set(p.memberIds))

    const order = newClusters
        .map((c, i) => ({ i, size: c.memberIds.length }))
        .sort((a, b) => b.size - a.size)
        .map(x => x.i)

    for (const i of order) {
        let bestJ = -1
        let bestScore = FLOOR
        for (let j = 0; j < priors.length; j++) {
            const p = priors[j]!
            if (usedPriorIds.has(p.id)) continue
            const a = newSets[i]!
            const b = priorSets[j]!
            let inter = 0
            for (const x of a) if (b.has(x)) inter++
            const union = a.size + b.size - inter
            const sc = union === 0 ? 0 : inter / union
            if (sc >= bestScore) { bestScore = sc; bestJ = j }
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
    const idIndex = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) idIndex.set(entries[i]!.id, i)

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

            const centroid = meanUnitVector(memberVecs)

            // Pick exemplars via centroid-anchored MMR — done before
            // labelling so the LLM prompt can reference these.
            const idsByMemberOrder = c.members.map(k => entries[k]!.id)
            const exemplarIds = pickExemplarsMMR(idsByMemberOrder, memberVecs, centroid, N_EXEMPLARS, MMR_LAMBDA)
            const idToContent = new Map<string, string>()
            for (let k = 0; k < c.members.length; k++) {
                idToContent.set(entries[c.members[k]!]!.id, entries[c.members[k]!]!.content)
            }
            const exemplarContents = exemplarIds.map(id => idToContent.get(id) ?? '')

            // c-TF-IDF top-3 keyphrases (used both as Haiku hint and fallback label).
            const { label: ctfidfLabel, keyphrases } = ctfidfTop(memberContents, allContents, 3)

            // Phase 3 N.1 — Haiku JSON labelling at level=1 only.
            // Levels 0 and 2 use the c-TF-IDF label (cheap, deterministic).
            let label = ctfidfLabel
            let why: string | null = null
            if (level === 1) {
                const llm = await llmLabel(workspaceId, memberContents, keyphrases, exemplarContents)
                if (llm) {
                    label = llm.label
                    why = llm.why
                }
            }

            out.push({
                id: '',
                label,
                why,
                memberIds,
                exemplarIds,
                centroid,
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

    // 6) Stable IDs: Hungarian-on-centroid for level=1; member-Jaccard
    //    inheritance for levels 0 and 2.
    const priorL0 = await loadPriorThemesWithCentroid(workspaceId, 0)
    const priorL1 = await loadPriorThemesWithCentroid(workspaceId, 1)
    const priorL2 = await loadPriorThemesWithCentroid(workspaceId, 2)
    assignStableIdsByOverlap(perLevel[0]!, priorL0)
    assignStableIdsHungarian(perLevel[1]!, priorL1)
    assignStableIdsByOverlap(perLevel[2]!, priorL2)

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

    // Suppress lint: idIndex retained for future incremental clustering.
    void idIndex

    logger.info({ workspaceId, nEntries: entries.length, summary, durationMs }, 'clusterMemory complete (Louvain multires + UMAP + Haiku)')

    return {
        clusters: allClusters,
        noise,
        summary,
        umap,
        durationMs,
        algoVersion: ALGO_VERSION,
    }
}
