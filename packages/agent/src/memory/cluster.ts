// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory clustering — Phase α of the Platform Synthesis Engine.
 *
 * Pure-TS agglomerative clustering over `memory_entries.embedding` for a single
 * workspace. No Python sidecar, no extra deps. Returns clusters with a generated
 * label (LLM-grounded with c-TF-IDF fallback) and the cosine-coherence of each.
 *
 * Algorithm: greedy agglomerative cosine. Start with each item as its own
 * cluster, repeatedly merge the closest pair whose centroid-cosine ≥
 * `coherenceFloor`. Stop when no merge candidates remain. Drop clusters
 * smaller than `minClusterSize` to `noise[]`.
 *
 * Cost: O(n²) similarities up front; n is bounded per-workspace (Dustin's
 * corpus today is ~657 entries → ~215k pairs, sub-second). When n grows past
 * ~5k we'll need a kNN-graph variant — that's the only known scale ceiling.
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'
import { callModel } from '../providers/call-model.js'
import { resolveModel, resolveModelFromEnv, type AnyLanguageModel } from '../providers/registry.js'
import { loadSettingsFromInstances } from '../providers/settings-from-instances.js'

const logger = pino({ name: 'memory-cluster' })

export interface ClusteredMemory {
    id: string
    label: string
    memberIds: string[]
    centroid: number[]
    coherence: number
}

export interface ClusterMemoryResult {
    clusters: ClusteredMemory[]
    noise: string[]
}

interface RawEntry {
    id: string
    content: string
    embedding: number[]
    created_at: Date
}

const DEFAULT_MIN_CLUSTER_SIZE = 4
const DEFAULT_COHERENCE_FLOOR = 0.74
/** Safety cap — refuse to cluster more entries than this in one pass. */
const MAX_ENTRIES_PER_RUN = 8000

/** Cosine similarity between two equal-length vectors. */
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

/** Element-wise mean across a list of equal-length vectors. */
function meanVector(vecs: number[][]): number[] {
    if (vecs.length === 0) return []
    const len = vecs[0]!.length
    const out = new Array<number>(len).fill(0)
    for (const v of vecs) {
        for (let i = 0; i < len; i++) out[i]! += v[i] ?? 0
    }
    for (let i = 0; i < len; i++) out[i]! /= vecs.length
    return out
}

/** Mean intra-cluster pairwise cosine — cluster coherence proxy. */
function meanIntraCosine(vecs: number[][]): number {
    if (vecs.length < 2) return 1
    let sum = 0
    let n = 0
    for (let i = 0; i < vecs.length; i++) {
        for (let j = i + 1; j < vecs.length; j++) {
            sum += cosine(vecs[i]!, vecs[j]!)
            n++
        }
    }
    return n === 0 ? 1 : sum / n
}

/** Parse a pgvector textual representation (`[0.1,0.2,...]`) into a number[]. */
function parseVector(raw: unknown): number[] | null {
    if (raw == null) return null
    if (Array.isArray(raw)) return raw as number[]
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim().replace(/^\[/, '').replace(/\]$/, '')
    if (!trimmed) return null
    const parts = trimmed.split(',')
    const out = new Array<number>(parts.length)
    for (let i = 0; i < parts.length; i++) {
        const n = Number(parts[i])
        if (!Number.isFinite(n)) return null
        out[i] = n
    }
    return out
}

/** Stoplist for c-TF-IDF fallback labels. */
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for',
    'with', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'i', 'we', 'you',
    'they', 'he', 'she', 'it', 'this', 'that', 'these', 'those', 'as', 'at', 'by',
    'from', 'so', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would',
    'should', 'could', 'can', 'may', 'might', 'about', 'into', 'than', 'then',
    'there', 'here', 'just', 'not', 'no', 'yes', 'my', 'your', 'our', 'their',
    'me', 'us', 'them', 'him', 'her', 'his', 'its', 'one', 'two', 'three',
])

/** Tokenize content for c-TF-IDF: lowercase ASCII unigrams, length≥4, not in stoplist. */
function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 4 && !STOPWORDS.has(t))
}

/** c-TF-IDF top-1 unigram. Falls back to first non-stopword token of the first member. */
function ctfidfLabel(memberContents: string[], allCorpusContents: string[]): string {
    // term frequency in this cluster
    const clusterTf = new Map<string, number>()
    for (const c of memberContents) {
        for (const t of tokenize(c)) clusterTf.set(t, (clusterTf.get(t) ?? 0) + 1)
    }
    // document frequency across the whole corpus (one "doc" per entry)
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
    // fallback: first usable token, else generic
    for (const c of memberContents) {
        const toks = tokenize(c)
        if (toks[0]) return toks[0].charAt(0).toUpperCase() + toks[0].slice(1)
    }
    return 'Theme'
}

/** Ask the cheapest available chat model for a ≤42-char label. */
async function llmLabel(
    workspaceId: string,
    memberContents: string[],
): Promise<string | null> {
    try {
        const settings = await loadSettingsFromInstances(workspaceId)
        // Pick the cheapest chat-grade model. 'summarization' default-routes to
        // claude-haiku per DEFAULT_MODEL_ROUTING — exactly the haiku-style
        // floor the spec calls for. If the workspace has no AI settings yet,
        // fall through to env-resolved defaults (gpt-4o-mini / openrouter / ollama).
        let model: AnyLanguageModel | null = null
        let providerKey: string = 'env'
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

        const sample = memberContents
            .slice(0, 12)
            .map(c => `- ${c.slice(0, 120).replace(/\s+/g, ' ').trim()}`)
            .join('\n')

        const { text } = await callModel({
            model: model!,
            provider: providerKey,
            system: 'You are a concise label generator. Reply with ONLY the label text — no quotes, no period, no preamble, no explanation.',
            messages: [{
                role: 'user',
                content: `Summarize the common idea connecting these ${memberContents.length} items in <=42 chars, no quotes, no period:\n${sample}`,
            }],
            maxTokens: 32,
        })
        const cleaned = (text ?? '')
            .trim()
            .replace(/^["'`]+|["'`.]+$/g, '')
            .split('\n')[0]!
            .slice(0, 42)
            .trim()
        return cleaned || null
    } catch (err) {
        logger.warn({ err, workspaceId }, 'cluster.llmLabel failed — will fall back to c-TF-IDF')
        return null
    }
}

/**
 * Cluster every embedded memory_entry for a workspace.
 *
 * Skips entries with no embedding. Results are deterministic: ties broken
 * by lower memberIds[] sort key.
 */
export async function clusterMemory(
    workspaceId: string,
    opts?: { minClusterSize?: number; coherenceFloor?: number },
): Promise<ClusterMemoryResult> {
    const minClusterSize = opts?.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE
    const coherenceFloor = opts?.coherenceFloor ?? DEFAULT_COHERENCE_FLOOR

    // Pull embeddings via raw SQL — drizzle has no vector accessor. Cast vector
    // → text so it round-trips through pg as a parsable string literal.
    const rows = Array.from(await db.execute<{
        id: string
        content: string
        embedding: string | null
        created_at: Date
    }>(sql`
        SELECT id, content, embedding::text AS embedding, created_at
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND type = 'pattern'
          AND embedding IS NOT NULL
        ORDER BY created_at ASC
        LIMIT ${MAX_ENTRIES_PER_RUN}
    `))

    const entries: RawEntry[] = []
    for (const r of rows) {
        const v = parseVector(r.embedding)
        if (!v || v.length === 0) continue
        entries.push({ id: r.id, content: r.content, embedding: v, created_at: r.created_at })
    }

    if (entries.length === 0) {
        return { clusters: [], noise: [] }
    }

    // Greedy agglomerative cosine. Track each cluster as { indices, centroid }.
    type Group = { indices: number[]; centroid: number[] }
    const groups: Group[] = entries.map((e, i) => ({ indices: [i], centroid: e.embedding }))

    // Precompute pairwise group-centroid sims as a sparse-ish max-heap by linear
    // scan each round — n≤8k, so a quadratic pass is fine. We re-scan only the
    // changed row+col after each merge to avoid full O(n³).
    let merged = true
    while (merged) {
        merged = false
        let bestI = -1, bestJ = -1, bestSim = coherenceFloor
        for (let i = 0; i < groups.length; i++) {
            for (let j = i + 1; j < groups.length; j++) {
                const sim = cosine(groups[i]!.centroid, groups[j]!.centroid)
                if (sim > bestSim) {
                    bestSim = sim
                    bestI = i
                    bestJ = j
                }
            }
        }
        if (bestI >= 0) {
            const a = groups[bestI]!
            const b = groups[bestJ]!
            const merged_indices = [...a.indices, ...b.indices]
            const merged_centroid = meanVector(merged_indices.map(k => entries[k]!.embedding))
            // splice the higher index first so the lower one stays valid
            groups.splice(bestJ, 1)
            groups.splice(bestI, 1)
            groups.push({ indices: merged_indices, centroid: merged_centroid })
            merged = true
        }
    }

    const clusters: ClusteredMemory[] = []
    const noise: string[] = []
    const allContents = entries.map(e => e.content)

    for (const g of groups) {
        if (g.indices.length < minClusterSize) {
            for (const k of g.indices) noise.push(entries[k]!.id)
            continue
        }
        const memberContents = g.indices.map(k => entries[k]!.content)
        const memberIds = g.indices.map(k => entries[k]!.id).sort()
        const memberVecs = g.indices.map(k => entries[k]!.embedding)
        const coherence = meanIntraCosine(memberVecs)

        // Final coherence gate (centroid-pass admitted some loose groups)
        if (coherence < coherenceFloor) {
            for (const k of g.indices) noise.push(entries[k]!.id)
            continue
        }

        let label = await llmLabel(workspaceId, memberContents)
        if (!label) label = ctfidfLabel(memberContents, allContents)

        clusters.push({
            id: '', // filled by the route once persisted
            label,
            memberIds,
            centroid: g.centroid,
            coherence,
        })
    }

    // Deterministic order: largest first, then by first memberId.
    clusters.sort((a, b) => b.memberIds.length - a.memberIds.length || (a.memberIds[0] ?? '').localeCompare(b.memberIds[0] ?? ''))

    return { clusters, noise }
}
