// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Themes-forest computation (Phase 8). The old postgres synthesis stack
 * (memory_themes / Leiden) was dropped in migration 0118; Graphiti is now
 * the canonical structure layer. This rebuilds a multi-level thematic
 * forest on demand by clustering the per-workspace FalkorDB Entity graph.
 *
 * Approach (v1, on-demand + cached upstream):
 *   1. RELATES_TO entity edges → undirected adjacency (isolated entities,
 *      which are mostly agent-operational noise, fall out naturally).
 *   2. Label-propagation → communities = THEMES (level 1).
 *   3. Label-propagation over the theme adjacency graph → super-communities
 *      = REGIONS (level 0). Each theme gets exactly one region parent.
 *   4. MENTIONS edges → assign each Episodic (a concrete note/capture) to
 *      the theme its mentioned entities most belong to = MEMBERS.
 *
 * Pure functions here; all graph I/O is injected by the route so this is
 * unit-testable without a sidecar.
 */

export interface EntityEdge {
    a: string
    b: string
}

export interface EntityMeta {
    uuid: string
    name: string
}

export interface MentionEdge {
    episodeId: string
    episodeLabel: string
    episodeKind: string
    entityId: string
}

export interface ForestRegion {
    id: string
    stableId: string
    label: string
    level: 0
    size: number
    coherence: number | null
    why: string | null
    isScl: boolean
}

export interface ForestTheme {
    id: string
    stableId: string
    label: string
    level: 1
    size: number
    coherence: number | null
    why: string | null
    isScl: boolean
    parentId: string | null
}

export interface ForestMember {
    id: string
    label: string
    kind: string
    themeId: string | null
    regionId: string | null
    url: string | null
    score: number
}

export interface ThemesForest {
    regions: ForestRegion[]
    themes: ForestTheme[]
    subthemes: never[]
    members: ForestMember[]
    runId: string | null
    generatedAt: string | null
}

const MIN_THEME_SIZE = 3
const MAX_MEMBERS = 2000
const MAX_MEMBERS_PER_THEME = 40

/**
 * The shared workspace graph is polluted with Plexo's own agent-operational
 * memory (cron logs, stabilization runs, internal file artifacts) which
 * otherwise dominate the largest themes and bury the user's real knowledge.
 * We can't filter by episode source — all episodes share one
 * `app:plexo|src:storeMemory` source — so we drop entities whose *name*
 * looks like an operational artifact. Conservative: only obvious infra
 * noise is matched; a missed item just stays in the forest.
 */
const NOISE_NAME_RE =
    /(\.(md|json|ya?ml|ts|js|mjs|cjs|log|txt|csv|sh)$)|\b(cron|cronjob|stabiliz|flush[_ ]?retrieval|retrieval[_ ]?counts|__internal|smoke[_ -]?test|ts-node|tsx?\b|execution[_ ]?log|poll(ing)? (job|cron)|agent[_ ]?(run|log|execution)|routine:)\b/i

const NOISE_EXACT = new Set([
    'task: general',
    'gmail poll cron job',
    'flushretrievalcounts',
    'ts-node',
])

export function isNoiseEntity(name: string): boolean {
    const t = name.trim().toLowerCase()
    if (!t) return false
    if (NOISE_EXACT.has(t)) return true
    return NOISE_NAME_RE.test(name)
}

/**
 * Deterministic synchronous label propagation. Communities are seeded to
 * each node's own id; each round a node adopts the most frequent community
 * among its neighbours, ties broken by lexicographically smallest id so
 * the result is stable across runs (the viz must not reshuffle on every
 * cache refresh).
 */
export function labelPropagation(
    nodes: string[],
    adjacency: Map<string, Set<string>>,
    iterations = 8,
): Map<string, string> {
    const community = new Map<string, string>(nodes.map((n) => [n, n]))
    const order = [...nodes].sort()
    for (let i = 0; i < iterations; i++) {
        let changed = false
        for (const n of order) {
            const neighbours = adjacency.get(n)
            if (!neighbours || neighbours.size === 0) continue
            const counts = new Map<string, number>()
            for (const m of neighbours) {
                const c = community.get(m)!
                counts.set(c, (counts.get(c) ?? 0) + 1)
            }
            let best = community.get(n)!
            let bestCount = -1
            for (const [c, cnt] of counts) {
                if (cnt > bestCount || (cnt === bestCount && c < best)) {
                    best = c
                    bestCount = cnt
                }
            }
            if (best !== community.get(n)) {
                community.set(n, best)
                changed = true
            }
        }
        if (!changed) break
    }
    return community
}

function buildAdjacency(edges: EntityEdge[]): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>()
    const add = (x: string, y: string) => {
        let s = adj.get(x)
        if (!s) {
            s = new Set<string>()
            adj.set(x, s)
        }
        s.add(y)
    }
    for (const e of edges) {
        if (e.a === e.b) continue
        add(e.a, e.b)
        add(e.b, e.a)
    }
    return adj
}

function degree(adj: Map<string, Set<string>>, n: string): number {
    return adj.get(n)?.size ?? 0
}

/** Internal-edge density of a node set: actual / possible undirected edges. */
function coherenceOf(members: string[], adj: Map<string, Set<string>>): number | null {
    const n = members.length
    if (n < 2) return null
    const set = new Set(members)
    let internal = 0
    for (const m of members) {
        for (const nb of adj.get(m) ?? []) {
            if (set.has(nb)) internal++
        }
    }
    internal /= 2 // each undirected edge counted twice
    const possible = (n * (n - 1)) / 2
    return possible === 0 ? null : Math.min(1, internal / possible)
}

export interface BuildForestInput {
    entityEdges: EntityEdge[]
    entityMeta: Map<string, EntityMeta>
    mentions: MentionEdge[]
    runId: string
    generatedAt: string
}

export function buildForest(input: BuildForestInput): ThemesForest {
    const { entityMeta, runId, generatedAt } = input

    // Drop agent-operational noise entities before clustering so they don't
    // form (and dominate) themes.
    const noise = new Set<string>()
    for (const [uuid, meta] of entityMeta) {
        if (isNoiseEntity(meta.name)) noise.add(uuid)
    }
    const entityEdges = input.entityEdges.filter((e) => !noise.has(e.a) && !noise.has(e.b))
    const mentions = input.mentions.filter((m) => !noise.has(m.entityId))

    const adj = buildAdjacency(entityEdges)
    const connected = [...adj.keys()]

    // 1. Themes = label-propagation communities of size >= MIN_THEME_SIZE.
    const entComm = labelPropagation(connected, adj)
    const groups = new Map<string, string[]>()
    for (const [ent, comm] of entComm) {
        const g = groups.get(comm) ?? []
        g.push(ent)
        groups.set(comm, g)
    }

    // Stable theme id = min entity uuid in the community.
    const themeOfEntity = new Map<string, string>()
    const themeEntities = new Map<string, string[]>()
    for (const [, ents] of groups) {
        if (ents.length < MIN_THEME_SIZE) continue
        const themeKey = [...ents].sort()[0]
        const themeId = `theme:${themeKey}`
        themeEntities.set(themeId, ents)
        for (const e of ents) themeOfEntity.set(e, themeId)
    }

    // 2. Regions = label-propagation over the theme adjacency graph (themes
    // are adjacent when an entity edge crosses between them).
    const themeAdj = new Map<string, Set<string>>()
    for (const t of themeEntities.keys()) themeAdj.set(t, new Set())
    for (const e of entityEdges) {
        const ta = themeOfEntity.get(e.a)
        const tb = themeOfEntity.get(e.b)
        if (ta && tb && ta !== tb) {
            themeAdj.get(ta)!.add(tb)
            themeAdj.get(tb)!.add(ta)
        }
    }
    const regionComm = labelPropagation([...themeEntities.keys()], themeAdj)
    const regionIdOfTheme = new Map<string, string>()
    for (const themeId of themeEntities.keys()) {
        const rc = regionComm.get(themeId) ?? themeId
        regionIdOfTheme.set(themeId, `region:${rc.replace(/^theme:/, '')}`)
    }

    // Helpers to label a community by its highest-degree entity name.
    const labelFor = (ents: string[]): string => {
        let best = ''
        let bestDeg = -1
        for (const e of ents) {
            const d = degree(adj, e)
            if (d > bestDeg) {
                bestDeg = d
                best = entityMeta.get(e)?.name ?? e
            }
        }
        return best || 'Untitled theme'
    }

    // 3. Build theme + region records.
    const themes: ForestTheme[] = []
    const regionEntities = new Map<string, string[]>()
    for (const [themeId, ents] of themeEntities) {
        const regionId = regionIdOfTheme.get(themeId)!
        const re = regionEntities.get(regionId) ?? []
        re.push(...ents)
        regionEntities.set(regionId, re)
        themes.push({
            id: themeId,
            stableId: themeId,
            label: labelFor(ents),
            level: 1,
            size: ents.length,
            coherence: coherenceOf(ents, adj),
            why: null,
            isScl: false,
            parentId: regionId,
        })
    }
    const regions: ForestRegion[] = []
    for (const [regionId, ents] of regionEntities) {
        regions.push({
            id: regionId,
            stableId: regionId,
            label: labelFor(ents),
            level: 0,
            size: ents.length,
            coherence: coherenceOf(ents, adj),
            why: null,
            isScl: false,
        })
    }

    // 4. Members = Episodics assigned to the theme they most mention.
    const episodeVotes = new Map<string, Map<string, number>>()
    const episodeInfo = new Map<string, { label: string; kind: string }>()
    for (const m of mentions) {
        const themeId = themeOfEntity.get(m.entityId)
        if (!themeId) continue
        if (!episodeInfo.has(m.episodeId)) {
            episodeInfo.set(m.episodeId, { label: m.episodeLabel, kind: m.episodeKind })
        }
        const votes = episodeVotes.get(m.episodeId) ?? new Map<string, number>()
        votes.set(themeId, (votes.get(themeId) ?? 0) + 1)
        episodeVotes.set(m.episodeId, votes)
    }
    const perTheme = new Map<string, number>()
    const members: ForestMember[] = []
    // Highest-vote episodes first so the per-theme cap keeps the strongest.
    const ranked = [...episodeVotes.entries()]
        .map(([epId, votes]) => {
            let themeId = ''
            let score = -1
            for (const [t, c] of votes) {
                if (c > score) {
                    score = c
                    themeId = t
                }
            }
            return { epId, themeId, score }
        })
        .sort((x, y) => y.score - x.score)
    for (const { epId, themeId, score } of ranked) {
        if (members.length >= MAX_MEMBERS) break
        const count = perTheme.get(themeId) ?? 0
        if (count >= MAX_MEMBERS_PER_THEME) continue
        perTheme.set(themeId, count + 1)
        const info = episodeInfo.get(epId)!
        members.push({
            id: epId,
            label: info.label || 'Untitled',
            kind: info.kind || 'note',
            themeId,
            regionId: regionIdOfTheme.get(themeId) ?? null,
            url: null,
            score,
        })
    }

    return { regions, themes, subthemes: [], members, runId, generatedAt }
}
