// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { buildExecutionWaves } from './topo-sort.js'

describe('buildExecutionWaves', () => {
    it('returns empty array for empty input', () => {
        expect(buildExecutionWaves([])).toEqual([])
    })

    it('single node with no deps → one wave', () => {
        expect(buildExecutionWaves([{ id: 'a', depends_on: [] }])).toEqual([['a']])
    })

    it('all independent nodes → single wave', () => {
        const nodes = [
            { id: 'a', depends_on: [] },
            { id: 'b', depends_on: [] },
            { id: 'c', depends_on: [] },
        ]
        expect(buildExecutionWaves(nodes)).toEqual([['a', 'b', 'c']])
    })

    it('linear chain → one node per wave', () => {
        const nodes = [
            { id: 'a', depends_on: [] },
            { id: 'b', depends_on: ['a'] },
            { id: 'c', depends_on: ['b'] },
        ]
        const waves = buildExecutionWaves(nodes)
        expect(waves).toEqual([['a'], ['b'], ['c']])
    })

    it('diamond dependency → correct wave ordering', () => {
        // a → b, a → c, b → d, c → d
        const nodes = [
            { id: 'a', depends_on: [] },
            { id: 'b', depends_on: ['a'] },
            { id: 'c', depends_on: ['a'] },
            { id: 'd', depends_on: ['b', 'c'] },
        ]
        const waves = buildExecutionWaves(nodes)
        expect(waves[0]).toEqual(['a'])
        expect(waves[1]).toEqual(expect.arrayContaining(['b', 'c']))
        expect(waves[1]).toHaveLength(2)
        expect(waves[2]).toEqual(['d'])
    })

    it('dependency on unknown id is treated as satisfied (external dep)', () => {
        // 'ext' is not in the node list — treated as already resolved
        const nodes = [
            { id: 'a', depends_on: ['ext'] },
            { id: 'b', depends_on: ['a'] },
        ]
        const waves = buildExecutionWaves(nodes)
        expect(waves[0]).toEqual(['a'])
        expect(waves[1]).toEqual(['b'])
    })

    it('cycle → remaining nodes emitted as final wave (no infinite loop)', () => {
        const nodes = [
            { id: 'a', depends_on: ['b'] },
            { id: 'b', depends_on: ['a'] },
        ]
        const waves = buildExecutionWaves(nodes)
        // Exactly one wave containing both cycled nodes
        expect(waves).toHaveLength(1)
        expect(waves[0]).toEqual(expect.arrayContaining(['a', 'b']))
    })

    it('partial cycle — non-cycled nodes still resolve before cycle dump', () => {
        const nodes = [
            { id: 'a', depends_on: [] },
            { id: 'b', depends_on: ['c'] },
            { id: 'c', depends_on: ['b'] },
        ]
        const waves = buildExecutionWaves(nodes)
        expect(waves[0]).toEqual(['a'])
        expect(waves[1]).toEqual(expect.arrayContaining(['b', 'c']))
    })

    it('wave IDs preserve input order within each wave', () => {
        const nodes = [
            { id: 'z', depends_on: [] },
            { id: 'm', depends_on: [] },
            { id: 'a', depends_on: [] },
        ]
        expect(buildExecutionWaves(nodes)[0]).toEqual(['z', 'm', 'a'])
    })
})
