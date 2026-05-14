// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * `memory.cluster.*` — generic semantic clustering API.
 *
 * This is the platform's shared clustering primitive. The Phase 1+3 synthesis
 * pipeline (`memory/cluster.ts`) is workspace-aware and DB-backed; it stays
 * the canonical surface for the synthesis nightly. THIS module is the
 * stateless, generic version that BOTH Nexalog graph callers and Plexo SCL
 * consume — give it `{id, vector}` items, get back `{id, clusterId, score}`.
 *
 * Algorithms (kept simple on purpose — see "API shape matters more"):
 *
 *   - method='kmeans'        — k-means++ init, cosine distance, k auto-pick
 *                              via silhouette over [2..√N] when not given
 *   - method='agglomerative' — single-link agglomerative on cosine distance,
 *                              cut at the supplied threshold
 *   - method='hdbscan'       — NOT YET. Reserved seam — when a real HDBSCAN
 *                              implementation drops in, the public API does
 *                              not change. Calling it now throws NOT_IMPL.
 *
 * The `topicLabel(items)` helper routes through the existing Haiku label
 * pipeline (`cluster.ts/llmLabel` is private — we call its export indirectly
 * by reusing the same prompt + provider chain) so the label/why outputs are
 * identical across the synthesis cluster path and any caller of this API.
 *
 * EVERY function here is workspace-id-optional. When omitted, the system
 * workspace forces the default (Xenova) provider, which is what other apps
 * want when they're not yet aware of workspaces.
 */
import pino from 'pino'
import { z } from 'zod'
import type { WorkspaceAISettings } from '../providers/registry.js'

const logger = pino({ name: 'memory:cluster-api' })

const SYSTEM_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000'

/* ── Public types ─────────────────────────────────────────────────────── */

export type ClusterMethod = 'kmeans' | 'agglomerative' | 'hdbscan'

export interface ClusterItem {
    id: string
    vector: number[] | Float32Array
}

export interface ClusterAssignment {
    id: string
    /** -1 = noise (only emitted by hdbscan path; never by kmeans). */
    clusterId: number
    /** Cosine similarity to the assigned cluster's centroid (0..1). */
    score: number
}

export interface ClusterOptions {
    method?: ClusterMethod
    /** Drop clusters below this size; their members move to noise. Default 2. */
    minClusterSize?: number
    /** kmeans only — fixed k. Omit for silhouette-picked k. */
    k?: number
    /** agglomerative only — cosine-distance cut threshold (0..2). Default 0.3. */
    distanceThreshold?: number
    /** Random seed for kmeans++ init. Default 0xC0FFEE. */
    seed?: number
    /** Max kmeans iterations. Default 30. */
    maxIter?: number
}

export interface ClusterResult {
    assignments: ClusterAssignment[]
    /** Per-cluster summary so callers don't have to recompute. */
    clusters: Array<{
        clusterId: number
        size: number
        centroid: number[]
        coherence: number
        memberIds: string[]
    }>
    /** Members that were dropped by min-size filter. */
    noise: string[]
    method: ClusterMethod
    /** Effective k chosen if `opts.k` was omitted. */
    chosenK: number | null
    durationMs: number
}

export interface TopicLabelInput {
    /** Member contents in cluster — used as exemplars. */
    contents: string[]
    /** Optional broader corpus for c-TF-IDF keyphrase backoff. */
    corpus?: string[]
    /** Workspace whose AI settings/model resolution to use. */
    workspaceId?: string
    aiSettings?: WorkspaceAISettings | null
}

export interface TopicLabelResult {
    label: string
    /** One-sentence rationale. May be empty when the LLM path falls back. */
    summary: string
    /** Where the label came from. */
    source: 'haiku' | 'ctfidf'
}

/* ── Math helpers ─────────────────────────────────────────────────────── */

function asNumberArray(v: number[] | Float32Array): number[] {
    return v instanceof Float32Array ? Array.from(v) : v
}

function cosineSim(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) {
        const x = a[i] ?? 0
        const y = b[i] ?? 0
        dot += x * y; na += x * x; nb += y * y
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom === 0 ? 0 : dot / denom
}

function cosineDist(a: number[], b: number[]): number {
    return 1 - cosineSim(a, b)
}

function meanUnitVector(vs: number[][]): number[] {
    if (vs.length === 0) return []
    const len = vs[0]!.length
    const out = new Array<number>(len).fill(0)
    for (const v of vs) {
        let n = 0
        for (let i = 0; i < len; i++) n += (v[i] ?? 0) * (v[i] ?? 0)
        const norm = Math.sqrt(n) || 1
        for (let i = 0; i < len; i++) out[i]! += (v[i] ?? 0) / norm
    }
    for (let i = 0; i < len; i++) out[i]! /= vs.length
    return out
}

function meanIntraCosine(vs: number[][]): number {
    if (vs.length < 2) return 1
    let sum = 0, n = 0
    for (let i = 0; i < vs.length; i++) {
        for (let j = i + 1; j < vs.length; j++) {
            sum += cosineSim(vs[i]!, vs[j]!); n++
        }
    }
    return n === 0 ? 1 : sum / n
}

/* ── Tiny seedable PRNG (mulberry32) ──────────────────────────────────── */

function mulberry32(seed: number): () => number {
    let s = seed >>> 0
    return () => {
        s = (s + 0x6D2B79F5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/* ── k-means++ ────────────────────────────────────────────────────────── */

function kmeansPlusPlusInit(vecs: number[][], k: number, rng: () => number): number[][] {
    const N = vecs.length
    if (N === 0 || k <= 0) return []
    const seeds: number[][] = []
    const firstIdx = Math.floor(rng() * N)
    seeds.push(vecs[firstIdx]!.slice())

    while (seeds.length < k) {
        const dists = new Array<number>(N).fill(0)
        let total = 0
        for (let i = 0; i < N; i++) {
            let minD = Infinity
            for (const s of seeds) {
                const d = cosineDist(vecs[i]!, s)
                if (d < minD) minD = d
            }
            dists[i] = minD * minD
            total += dists[i]!
        }
        if (total <= 0) break
        const r = rng() * total
        let acc = 0, picked = 0
        for (let i = 0; i < N; i++) {
            acc += dists[i]!
            if (acc >= r) { picked = i; break }
        }
        seeds.push(vecs[picked]!.slice())
    }
    return seeds
}

function kmeans(vecs: number[][], k: number, opts: { seed: number; maxIter: number }): { labels: number[]; centroids: number[][] } {
    const N = vecs.length
    if (N === 0) return { labels: [], centroids: [] }
    if (k >= N) {
        // Each point is its own cluster
        return { labels: vecs.map((_, i) => i), centroids: vecs.map(v => v.slice()) }
    }
    const rng = mulberry32(opts.seed)
    let centroids = kmeansPlusPlusInit(vecs, k, rng)
    let labels = new Array<number>(N).fill(0)

    for (let iter = 0; iter < opts.maxIter; iter++) {
        let changed = false
        // Assign
        for (let i = 0; i < N; i++) {
            let bestK = 0, bestD = Infinity
            for (let c = 0; c < centroids.length; c++) {
                const d = cosineDist(vecs[i]!, centroids[c]!)
                if (d < bestD) { bestD = d; bestK = c }
            }
            if (labels[i] !== bestK) { labels[i] = bestK; changed = true }
        }
        // Update
        const buckets: number[][][] = Array.from({ length: centroids.length }, () => [])
        for (let i = 0; i < N; i++) buckets[labels[i]!]!.push(vecs[i]!)
        const next = centroids.map((c, idx) => {
            const b = buckets[idx]!
            return b.length === 0 ? c : meanUnitVector(b)
        })
        centroids = next
        if (!changed) break
    }
    return { labels, centroids }
}

/** Mean silhouette over cosine distance. Used to auto-pick k. */
function silhouette(vecs: number[][], labels: number[]): number {
    const N = vecs.length
    if (N < 3) return 0
    const byK = new Map<number, number[]>()
    for (let i = 0; i < N; i++) {
        const k = labels[i]!
        const arr = byK.get(k); if (arr) arr.push(i); else byK.set(k, [i])
    }
    if (byK.size < 2) return 0

    let total = 0
    for (let i = 0; i < N; i++) {
        const own = labels[i]!
        const ownIdx = byK.get(own)!
        let aSum = 0, aN = 0
        for (const j of ownIdx) if (j !== i) { aSum += cosineDist(vecs[i]!, vecs[j]!); aN++ }
        const a = aN === 0 ? 0 : aSum / aN

        let b = Infinity
        for (const [k, idx] of byK) {
            if (k === own) continue
            let s = 0
            for (const j of idx) s += cosineDist(vecs[i]!, vecs[j]!)
            const m = s / idx.length
            if (m < b) b = m
        }
        const denom = Math.max(a, b) || 1
        total += (b - a) / denom
    }
    return total / N
}

/* ── Single-link agglomerative on cosine distance ─────────────────────── */

function agglomerative(vecs: number[][], threshold: number): { labels: number[] } {
    const N = vecs.length
    if (N === 0) return { labels: [] }
    // Disjoint-set union
    const parent = new Array<number>(N).fill(0).map((_, i) => i)
    const find = (x: number): number => {
        let r = x; while (parent[r] !== r) r = parent[r]!
        while (parent[x] !== r) { const n = parent[x]!; parent[x] = r; x = n }
        return r
    }
    const union = (a: number, b: number): void => {
        const ra = find(a), rb = find(b)
        if (ra !== rb) parent[ra] = rb
    }

    // Single-link: merge any pair whose distance ≤ threshold.
    // O(N²) but with N≤a few thousand that's fine; SCL graph callers typically
    // hand us tens-to-hundreds.
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            if (cosineDist(vecs[i]!, vecs[j]!) <= threshold) union(i, j)
        }
    }

    // Reindex roots → 0..K-1 for stable cluster ids
    const idMap = new Map<number, number>()
    const labels = new Array<number>(N).fill(0)
    let next = 0
    for (let i = 0; i < N; i++) {
        const root = find(i)
        let id = idMap.get(root)
        if (id === undefined) { id = next++; idMap.set(root, id) }
        labels[i] = id
    }
    return { labels }
}

/* ── Public: cluster() ────────────────────────────────────────────────── */

export async function cluster(items: ClusterItem[], opts: ClusterOptions = {}): Promise<ClusterResult> {
    const t0 = Date.now()
    const method = opts.method ?? 'kmeans'
    const minClusterSize = Math.max(1, opts.minClusterSize ?? 2)

    if (items.length === 0) {
        return {
            assignments: [],
            clusters: [],
            noise: [],
            method,
            chosenK: null,
            durationMs: Date.now() - t0,
        }
    }

    if (method === 'hdbscan') {
        // Reserved seam — see file header. Don't silently degrade; callers
        // that explicitly request hdbscan need to know it isn't wired yet.
        const err = new Error('cluster: method=hdbscan not yet implemented; pass method=agglomerative or kmeans')
        ;(err as Error & { code?: string }).code = 'METHOD_NOT_IMPLEMENTED'
        throw err
    }

    const vecs = items.map(i => asNumberArray(i.vector))
    const N = vecs.length

    let labels: number[]
    let chosenK: number | null = null

    if (method === 'agglomerative') {
        const threshold = opts.distanceThreshold ?? 0.3
        const out = agglomerative(vecs, threshold)
        labels = out.labels
    } else {
        // kmeans
        const seed = opts.seed ?? 0xC0FFEE
        const maxIter = opts.maxIter ?? 30

        let k: number
        if (typeof opts.k === 'number' && opts.k > 0) {
            k = Math.min(opts.k, N)
        } else {
            // Auto-pick: search [2..ceil(sqrt(N))], best mean silhouette
            const upper = Math.max(2, Math.min(Math.ceil(Math.sqrt(N)), 12))
            let bestK = 2, bestS = -Infinity
            for (let kc = 2; kc <= upper; kc++) {
                const r = kmeans(vecs, kc, { seed, maxIter })
                const s = silhouette(vecs, r.labels)
                if (s > bestS) { bestS = s; bestK = kc }
            }
            k = bestK
            chosenK = k
        }
        const result = kmeans(vecs, k, { seed, maxIter })
        labels = result.labels
        if (chosenK === null) chosenK = k
    }

    // Group, drop small clusters into noise, recompute centroids/coherence.
    const groups = new Map<number, number[]>()
    for (let i = 0; i < N; i++) {
        const id = labels[i]!
        const list = groups.get(id); if (list) list.push(i); else groups.set(id, [i])
    }

    const clusters: ClusterResult['clusters'] = []
    const noise: string[] = []
    const liveIdMap = new Map<number, number>() // raw id → compact id
    let nextId = 0

    for (const [rawId, idxs] of Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length)) {
        if (idxs.length < minClusterSize) {
            for (const i of idxs) noise.push(items[i]!.id)
            continue
        }
        const memberVecs = idxs.map(i => vecs[i]!)
        const memberIds = idxs.map(i => items[i]!.id)
        const centroid = meanUnitVector(memberVecs)
        const coherence = meanIntraCosine(memberVecs)
        const cid = nextId++
        liveIdMap.set(rawId, cid)
        clusters.push({ clusterId: cid, size: memberIds.length, centroid, coherence, memberIds })
    }

    const assignments: ClusterAssignment[] = []
    for (let i = 0; i < N; i++) {
        const cid = liveIdMap.get(labels[i]!)
        if (cid === undefined) {
            assignments.push({ id: items[i]!.id, clusterId: -1, score: 0 })
            continue
        }
        const c = clusters.find(c => c.clusterId === cid)!
        assignments.push({ id: items[i]!.id, clusterId: cid, score: cosineSim(vecs[i]!, c.centroid) })
    }

    logger.debug({ method, N, k: chosenK, clusters: clusters.length, noise: noise.length }, 'cluster done')

    return {
        assignments,
        clusters,
        noise,
        method,
        chosenK,
        durationMs: Date.now() - t0,
    }
}

/* ── Public: topicLabel() ─────────────────────────────────────────────── */

const labelSchema = z.object({
    label: z.string().min(1).max(80),
    why: z.string().min(1).max(280),
})

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for',
    'with', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'i', 'we', 'you',
    'they', 'he', 'she', 'it', 'this', 'that', 'these', 'those', 'as', 'at', 'by',
    'from', 'so', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would',
    'should', 'could', 'can', 'may', 'might', 'about', 'into', 'than', 'then',
    'there', 'here', 'just', 'not', 'no', 'yes', 'my', 'your', 'our', 'their',
])

function tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter(t => t.length >= 4 && !STOPWORDS.has(t))
}

function ctfidfFallback(contents: string[], corpus: string[]): { label: string; keyphrases: string[] } {
    const clusterTf = new Map<string, number>()
    for (const c of contents) for (const t of tokenize(c)) clusterTf.set(t, (clusterTf.get(t) ?? 0) + 1)
    const docFreq = new Map<string, number>()
    const docs = corpus.length > 0 ? corpus : contents
    for (const c of docs) {
        const seen = new Set<string>()
        for (const t of tokenize(c)) { if (!seen.has(t)) { docFreq.set(t, (docFreq.get(t) ?? 0) + 1); seen.add(t) } }
    }
    const N = Math.max(1, docs.length)
    const scored: Array<{ term: string; score: number }> = []
    for (const [term, tf] of clusterTf.entries()) {
        const df = docFreq.get(term) ?? 1
        scored.push({ term, score: tf * Math.log(N / df) })
    }
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, 3).map(s => s.term)
    const labelTerm = top[0] ?? ''
    const label = labelTerm
        ? labelTerm.charAt(0).toUpperCase() + labelTerm.slice(1)
        : (contents[0]?.split(/\s+/).slice(0, 3).join(' ') || 'Cluster')
    return { label, keyphrases: top }
}

/**
 * Label a cluster using the same Haiku-JSON pipeline as the synthesis path.
 * Falls back to c-TF-IDF when the LLM is unreachable.
 *
 * Implementation note: we deliberately re-resolve the model rather than
 * importing the private llmLabel helper from cluster.ts — this keeps the
 * generic API independent of the synthesis-specific module's evolution and
 * means a Nexalog-only deployment can use this without dragging in the
 * memory_themes side of the synthesis module.
 */
export async function topicLabel(input: TopicLabelInput): Promise<TopicLabelResult> {
    const contents = input.contents.filter(s => s && s.trim()).slice(0, 12)
    if (contents.length === 0) return { label: 'Empty cluster', summary: '', source: 'ctfidf' }

    // Always have a c-TF-IDF fallback ready for graceful degradation.
    const { label: ctfidfLabel, keyphrases } = ctfidfFallback(contents, input.corpus ?? [])
    const workspaceId = input.workspaceId ?? SYSTEM_WORKSPACE_ID

    try {
        const { callModel } = await import('../providers/call-model.js')
        const { resolveModelFromEnv } = await import('../providers/registry.js')
        const { loadSettingsFromInstances } = await import('../providers/settings-from-instances.js')
        const { routeAndCall } = await import('../providers/router-v2/index.js')

        let settings = input.aiSettings
        if (settings === undefined) {
            try { settings = await loadSettingsFromInstances(workspaceId) ?? null } catch { settings = null }
        }

        const cleaned = contents.slice(0, 3).map(e => e.replace(/\s+/g, ' ').trim().slice(0, 220))
        const exemplarBlock = cleaned.map(e => `- ${e}`).join('\n')
        const keyBlock = keyphrases.join(', ') || '(none)'
        const N = contents.length

        const system = 'You name clusters of saved items. Output JSON only: {label, why}. Label ≤ 36 chars, noun phrase, no quotes, no period, English even if items are not.'
        const user = `These ${N} items cluster together. Top keyphrases: [${keyBlock}]. Exemplars:\n${exemplarBlock}\nName the cluster.`

        const doCall = (model: Parameters<typeof callModel>[0]['model']) => callModel({
            model,
            provider: 'router-v2',
            system,
            messages: [{ role: 'user', content: user }],
            maxTokens: 200,
            schema: labelSchema,
            schemaName: 'cluster_label',
            schemaDescription: 'Short English noun phrase + one-sentence rationale.',
        })

        let result: Awaited<ReturnType<typeof doCall>> | null = null
        if (settings) {
            try {
                result = await routeAndCall({ workspaceId, taskType: 'summarization', settings, doCall })
            } catch (err) {
                logger.warn({ err, workspaceId }, 'topicLabel: routeAndCall failed — env fallback')
            }
        }
        if (!result) {
            let envModel: Parameters<typeof callModel>[0]['model']
            try { envModel = resolveModelFromEnv() } catch (err) {
                logger.warn({ err, workspaceId }, 'topicLabel: env resolve failed — c-TF-IDF fallback')
                return { label: ctfidfLabel, summary: '', source: 'ctfidf' }
            }
            result = await doCall(envModel)
        }

        const obj = (result as { object?: { label: string; why: string } }).object
        if (!obj) return { label: ctfidfLabel, summary: '', source: 'ctfidf' }
        const label = (obj.label ?? '').trim().replace(/^["'`]+|["'`.]+$/g, '').slice(0, 36).trim()
        const why = (obj.why ?? '').trim().slice(0, 280)
        if (!label) return { label: ctfidfLabel, summary: '', source: 'ctfidf' }
        return { label, summary: why, source: 'haiku' }
    } catch (err) {
        // Test mode (no models) hits this path, plus any Haiku outage.
        const tag = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : ''
        if (tag === 'CallModelError') {
            logger.warn({ workspaceId }, 'topicLabel: CallModelError — c-TF-IDF fallback')
        } else {
            logger.debug({ err, workspaceId }, 'topicLabel: LLM path failed — c-TF-IDF fallback')
        }
        return { label: ctfidfLabel, summary: '', source: 'ctfidf' }
    }
}
