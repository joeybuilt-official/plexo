// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Themes-forest clustering tests (Phase 8). Pins the pure clustering
 * behaviour so the on-demand pipeline can't silently regress:
 *   1. labelPropagation is deterministic + groups a connected clique.
 *   2. buildForest drops sub-MIN_THEME_SIZE communities (noise).
 *   3. two disjoint cliques → two themes, each its own region.
 *   4. members are assigned to the theme their mentions point at + capped.
 */

import { describe, it, expect } from 'vitest'
import {
    labelPropagation,
    buildForest,
    isNoiseEntity,
    type EntityEdge,
    type EntityMeta,
    type MentionEdge,
} from '../themes-forest.js'

function adjFrom(edges: EntityEdge[]): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>()
    const add = (x: string, y: string) => {
        const s = adj.get(x) ?? new Set<string>()
        s.add(y)
        adj.set(x, s)
    }
    for (const e of edges) {
        add(e.a, e.b)
        add(e.b, e.a)
    }
    return adj
}

function clique(prefix: string, n: number): EntityEdge[] {
    const ids = Array.from({ length: n }, (_, i) => `${prefix}${i}`)
    const edges: EntityEdge[] = []
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) edges.push({ a: ids[i]!, b: ids[j]! })
    }
    return edges
}

function meta(ids: string[]): Map<string, EntityMeta> {
    return new Map(ids.map((id) => [id, { uuid: id, name: `name-${id}` }]))
}

describe('labelPropagation', () => {
    it('collapses a connected clique into one community, deterministically', () => {
        const edges = clique('x', 4)
        const adj = adjFrom(edges)
        const nodes = [...adj.keys()]
        const a = labelPropagation(nodes, adj)
        const b = labelPropagation(nodes, adj)
        const communities = new Set(a.values())
        expect(communities.size).toBe(1)
        expect([...a.entries()]).toEqual([...b.entries()]) // deterministic
    })
})

describe('buildForest', () => {
    const base = { runId: 'run-1', generatedAt: '2026-06-08T00:00:00.000Z' }

    it('drops communities smaller than MIN_THEME_SIZE', () => {
        // A 2-node edge is below the size-3 floor → no themes.
        const edges: EntityEdge[] = [{ a: 'p0', b: 'p1' }]
        const forest = buildForest({
            ...base,
            entityEdges: edges,
            entityMeta: meta(['p0', 'p1']),
            mentions: [],
        })
        expect(forest.themes).toHaveLength(0)
        expect(forest.regions).toHaveLength(0)
        expect(forest.subthemes).toEqual([])
    })

    it('produces one theme + region per disjoint clique', () => {
        const edges = [...clique('a', 4), ...clique('b', 4)]
        const ids = [...new Set(edges.flatMap((e) => [e.a, e.b]))]
        const forest = buildForest({ ...base, entityEdges: edges, entityMeta: meta(ids), mentions: [] })
        expect(forest.themes).toHaveLength(2)
        // disjoint cliques don't share an edge → each theme its own region
        expect(new Set(forest.themes.map((t) => t.parentId)).size).toBe(2)
        for (const t of forest.themes) {
            expect(t.size).toBe(4)
            expect(t.parentId).toMatch(/^region:/)
            expect(t.coherence).toBeCloseTo(1, 5) // full clique
        }
    })

    it('assigns episodics to the theme their mentions point at', () => {
        const edges = clique('a', 3)
        const ids = ['a0', 'a1', 'a2']
        const mentions: MentionEdge[] = [
            { episodeId: 'ep1', episodeLabel: 'Note one', episodeKind: 'note', entityId: 'a0' },
            { episodeId: 'ep1', episodeLabel: 'Note one', episodeKind: 'note', entityId: 'a1' },
        ]
        const forest = buildForest({ ...base, entityEdges: edges, entityMeta: meta(ids), mentions })
        expect(forest.members).toHaveLength(1)
        const member = forest.members[0]!
        const theme = forest.themes[0]!
        expect(member.id).toBe('ep1')
        expect(member.themeId).toBe(theme.id)
        expect(member.regionId).toBe(theme.parentId)
    })

    it('drops agent-operational noise entities before clustering', () => {
        // A clean clique of real entities plus a noise clique that would
        // otherwise be its own theme.
        const realEdges = clique('r', 4)
        const noiseEdges = clique('n', 4)
        const ids = [...new Set([...realEdges, ...noiseEdges].flatMap((e) => [e.a, e.b]))]
        const metaMap = new Map<string, EntityMeta>(
            ids.map((id) => [
                id,
                { uuid: id, name: id.startsWith('n') ? `cron-job-report-${id}.json` : `Real Topic ${id}` },
            ]),
        )
        const forest = buildForest({
            ...base,
            entityEdges: [...realEdges, ...noiseEdges],
            entityMeta: metaMap,
            mentions: [],
        })
        expect(forest.themes).toHaveLength(1) // noise clique filtered out
        expect(forest.themes[0]!.label).toMatch(/Real Topic/)
    })

    it('carries runId/generatedAt through', () => {
        const forest = buildForest({ ...base, entityEdges: [], entityMeta: new Map(), mentions: [] })
        expect(forest.runId).toBe('run-1')
        expect(forest.generatedAt).toBe('2026-06-08T00:00:00.000Z')
    })
})
