// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach } from 'vitest'
import { buildExecutionWaves, type TopoNode } from './topo-sort.js'
import { buildCypherExecutionWavesById } from '../planner/cypher-waves.js'

// ── Mocked sidecar — translates the BFS cypher to a JS dep walk ─────────────
//
// The cypher path issues a single MATCH that returns `(id, deps[])` rows
// for every Task in the sprint. We synthesize that response shape from
// the fixture nodes so both paths assert against identical inputs.

function mockSidecarFromNodes(nodes: TopoNode[]): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
        expect(target).toMatch(/\/v1\/graph\/cypher$/)
        expect(init?.method).toBe('POST')
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers['X-Plexo-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
        expect(headers['X-Plexo-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        return new Response(
            JSON.stringify({
                header: ['id', 'deps'],
                rows: nodes.map((n) => [n.id, n.depends_on]),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
    }) as typeof fetch
}

interface Fixture {
    name: string
    nodes: TopoNode[]
    expected: (waves: string[][]) => void
}

const FIXTURES: Fixture[] = [
    {
        name: 'empty input → empty waves',
        nodes: [],
        expected: (w) => expect(w).toEqual([]),
    },
    {
        name: 'single node with no deps → one wave',
        nodes: [{ id: 'a', depends_on: [] }],
        expected: (w) => expect(w).toEqual([['a']]),
    },
    {
        name: 'all independent nodes → single wave',
        nodes: [
            { id: 'a', depends_on: [] },
            { id: 'b', depends_on: [] },
            { id: 'c', depends_on: [] },
        ],
        expected: (w) => expect(w).toEqual([['a', 'b', 'c']]),
    },
    {
        name: 'linear chain → one node per wave',
        nodes: [
            { id: 'a', depends_on: [] },
            { id: 'b', depends_on: ['a'] },
            { id: 'c', depends_on: ['b'] },
        ],
        expected: (w) => expect(w).toEqual([['a'], ['b'], ['c']]),
    },
    {
        name: 'diamond dependency → correct wave ordering',
        nodes: [
            { id: 'a', depends_on: [] },
            { id: 'b', depends_on: ['a'] },
            { id: 'c', depends_on: ['a'] },
            { id: 'd', depends_on: ['b', 'c'] },
        ],
        expected: (w) => {
            expect(w[0]).toEqual(['a'])
            expect(w[1]).toEqual(expect.arrayContaining(['b', 'c']))
            expect(w[1]).toHaveLength(2)
            expect(w[2]).toEqual(['d'])
        },
    },
    {
        name: 'dependency on unknown id is treated as satisfied (external dep)',
        nodes: [
            { id: 'a', depends_on: ['ext'] },
            { id: 'b', depends_on: ['a'] },
        ],
        expected: (w) => {
            expect(w[0]).toEqual(['a'])
            expect(w[1]).toEqual(['b'])
        },
    },
    {
        name: 'cycle → remaining nodes emitted as final wave (no infinite loop)',
        nodes: [
            { id: 'a', depends_on: ['b'] },
            { id: 'b', depends_on: ['a'] },
        ],
        expected: (w) => {
            expect(w).toHaveLength(1)
            expect(w[0]).toEqual(expect.arrayContaining(['a', 'b']))
        },
    },
    {
        name: 'partial cycle — non-cycled nodes still resolve before cycle dump',
        nodes: [
            { id: 'a', depends_on: [] },
            { id: 'b', depends_on: ['c'] },
            { id: 'c', depends_on: ['b'] },
        ],
        expected: (w) => {
            expect(w[0]).toEqual(['a'])
            expect(w[1]).toEqual(expect.arrayContaining(['b', 'c']))
        },
    },
    {
        name: 'wave IDs preserve input order within each wave',
        nodes: [
            { id: 'z', depends_on: [] },
            { id: 'm', depends_on: [] },
            { id: 'a', depends_on: [] },
        ],
        expected: (w) => expect(w[0]).toEqual(['z', 'm', 'a']),
    },
    {
        name: 'two parallel chains share a tail',
        nodes: [
            { id: 'a', depends_on: [] },
            { id: 'b', depends_on: [] },
            { id: 'c', depends_on: ['a'] },
            { id: 'd', depends_on: ['b'] },
            { id: 'e', depends_on: ['c', 'd'] },
        ],
        expected: (w) => {
            expect(w[0]).toEqual(expect.arrayContaining(['a', 'b']))
            expect(w[0]).toHaveLength(2)
            expect(w[1]).toEqual(expect.arrayContaining(['c', 'd']))
            expect(w[1]).toHaveLength(2)
            expect(w[2]).toEqual(['e'])
        },
    },
]

describe('buildExecutionWaves (JS path)', () => {
    for (const fx of FIXTURES) {
        it(fx.name, () => {
            fx.expected(buildExecutionWaves(fx.nodes))
        })
    }
})

describe('buildCypherExecutionWavesById (cypher path)', () => {
    const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
    const SPRINT_ID = 'sprint-test'

    beforeEach(() => {
        process.env.PLEXO_GRAPHITI_SIDECAR_URL = 'http://sidecar.test:8000'
        process.env.PLEXO_SERVICE_KEY = 'test-service-key'
    })

    for (const fx of FIXTURES) {
        it(`cypher: ${fx.name}`, async () => {
            const result = await buildCypherExecutionWavesById(WORKSPACE_ID, SPRINT_ID, {
                fetchImpl: mockSidecarFromNodes(fx.nodes),
            })
            // empty fixture: cypher returns header+0 rows → layerWaves returns []
            // — which matches the JS empty case.
            expect(result).not.toBeNull()
            fx.expected(result as string[][])
        })
    }

    it('falls back to null when sidecar is unconfigured', async () => {
        delete process.env.PLEXO_GRAPHITI_SIDECAR_URL
        delete process.env.PLEXO_SERVICE_KEY
        const result = await buildCypherExecutionWavesById(WORKSPACE_ID, SPRINT_ID)
        expect(result).toBeNull()
    })

    it('returns null when sidecar returns non-OK', async () => {
        const fail: typeof fetch = (async () =>
            new Response('{"error":"boom"}', { status: 500 })) as typeof fetch
        const result = await buildCypherExecutionWavesById(WORKSPACE_ID, SPRINT_ID, { fetchImpl: fail })
        expect(result).toBeNull()
    })

    it('returns null when sidecar response header is malformed', async () => {
        const bad: typeof fetch = (async () =>
            new Response(JSON.stringify({ header: ['wrong'], rows: [] }), { status: 200 })) as typeof fetch
        const result = await buildCypherExecutionWavesById(WORKSPACE_ID, SPRINT_ID, { fetchImpl: bad })
        expect(result).toBeNull()
    })
})

describe('parity: JS + cypher paths produce identical wave structure', () => {
    const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
    const SPRINT_ID = 'sprint-parity'

    beforeEach(() => {
        process.env.PLEXO_GRAPHITI_SIDECAR_URL = 'http://sidecar.test:8000'
        process.env.PLEXO_SERVICE_KEY = 'test-service-key'
    })

    for (const fx of FIXTURES) {
        it(`parity: ${fx.name}`, async () => {
            const jsWaves = buildExecutionWaves(fx.nodes)
            const cypherWaves = await buildCypherExecutionWavesById(WORKSPACE_ID, SPRINT_ID, {
                fetchImpl: mockSidecarFromNodes(fx.nodes),
            })
            expect(cypherWaves).not.toBeNull()
            // Sort each wave so order-within-wave doesn't matter (cycle
            // path + diamond fixtures intentionally allow either order).
            const normalize = (waves: string[][]): string[][] => waves.map((w) => [...w].sort())
            expect(normalize(cypherWaves as string[][])).toEqual(normalize(jsWaves))
        })
    }
})
