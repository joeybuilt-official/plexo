// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach } from 'vitest'
import { buildExecutionWaves, type TopoNode } from './topo-sort.js'

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
