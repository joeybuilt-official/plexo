// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tests for graph-query (ADR 0009 concept graph layer).
 *
 * Mocks @plexo/db (matching the pattern in resolve.test.ts) and
 * ../store.js for embed(). DB calls are observed via the mocked execute
 * function; we never touch a real database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecute = vi.fn()

vi.mock('@plexo/db', () => ({
    db: {
        execute: mockExecute,
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, values: vals, _kind: 'sql' }),
        { join: vi.fn((arr: unknown[]) => arr), raw: vi.fn((s: string) => ({ raw: s, _kind: 'sql' })) },
    ),
}))

const mockEmbed = vi.fn()
vi.mock('../store.js', () => ({
    embed: mockEmbed,
}))

beforeEach(() => {
    mockExecute.mockReset()
    mockEmbed.mockReset()
})

const WS = '00000000-0000-0000-0000-000000000001'
const ENTRY = '00000000-0000-0000-0000-0000000000aa'
const NODE_A = '00000000-0000-0000-0000-0000000000bb'
const VEC = new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0))

describe('graphMutate', () => {
    it('returns empty result for empty concepts', async () => {
        const { graphMutate } = await import('../graph-query.js')
        const r = await graphMutate({ workspaceId: WS, concepts: [], source: 'test' })
        expect(r).toEqual({ nodeIds: [], created: 0, existing: 0 })
        expect(mockExecute).not.toHaveBeenCalled()
    })

    it('upserts new node, links membership, infers edges', async () => {
        mockEmbed.mockResolvedValue(VEC)
        // 1st execute: upsert returning new row
        // 2nd execute: membership insert
        // 3rd execute: edge inference
        mockExecute
            .mockResolvedValueOnce([{ id: NODE_A, created: true }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])

        const { graphMutate } = await import('../graph-query.js')
        const r = await graphMutate({
            workspaceId: WS,
            concepts: [{ label: 'docker', type: 'tool' }],
            source: 'test',
            memoryEntryId: ENTRY,
        })

        expect(r.created).toBe(1)
        expect(r.existing).toBe(0)
        expect(r.nodeIds).toEqual([NODE_A])
        expect(mockExecute).toHaveBeenCalledTimes(3)
    })

    it('skips concept when embed fails', async () => {
        mockEmbed.mockResolvedValue(null)

        const { graphMutate } = await import('../graph-query.js')
        const r = await graphMutate({
            workspaceId: WS,
            concepts: [{ label: 'kafka' }],
            source: 'test',
        })

        expect(r).toEqual({ nodeIds: [], created: 0, existing: 0 })
        expect(mockExecute).not.toHaveBeenCalled()
    })

    it('counts existing-vs-created based on returned `created` flag', async () => {
        mockEmbed.mockResolvedValue(VEC)
        mockExecute
            .mockResolvedValueOnce([{ id: NODE_A, created: false }])
            // no membership call (no memoryEntryId)
            // no edge inference call (created=false)

        const { graphMutate } = await import('../graph-query.js')
        const r = await graphMutate({
            workspaceId: WS,
            concepts: [{ label: 'docker' }],
            source: 'test',
        })

        expect(r.created).toBe(0)
        expect(r.existing).toBe(1)
        expect(r.nodeIds).toEqual([NODE_A])
        expect(mockExecute).toHaveBeenCalledTimes(1)
    })
})

describe('graphExpand', () => {
    it('returns empty result for empty stimulus', async () => {
        const { graphExpand } = await import('../graph-query.js')
        const r = await graphExpand({ workspaceId: WS, stimulus: '   ' })
        expect(r).toEqual({ nodes: [], truncated: false })
        expect(mockEmbed).not.toHaveBeenCalled()
    })

    it('returns empty result when embed fails', async () => {
        mockEmbed.mockResolvedValue(null)

        const { graphExpand } = await import('../graph-query.js')
        const r = await graphExpand({ workspaceId: WS, stimulus: 'docker compose up' })
        expect(r).toEqual({ nodes: [], truncated: false })
        expect(mockExecute).not.toHaveBeenCalled()
    })

    it('returns nodes within width cap, truncated=false', async () => {
        mockEmbed.mockResolvedValue(VEC)
        // first execute: SET LOCAL statement_timeout (returns nothing meaningful)
        // second execute: BFS rows
        mockExecute
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { id: NODE_A, label: 'docker', type: 'tool', depth: 0 },
                { id: 'n2', label: 'compose', type: null, depth: 1 },
            ])

        const { graphExpand } = await import('../graph-query.js')
        const r = await graphExpand({ workspaceId: WS, stimulus: 'docker', width: 50 })
        expect(r.nodes).toHaveLength(2)
        expect(r.truncated).toBe(false)
        expect(r.nodes[0]?.label).toBe('docker')
    })

    it('flags truncated when result count exceeds width cap', async () => {
        mockEmbed.mockResolvedValue(VEC)
        mockExecute
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { id: 'n1', label: 'a', type: null, depth: 0 },
                { id: 'n2', label: 'b', type: null, depth: 1 },
                { id: 'n3', label: 'c', type: null, depth: 1 },
                { id: 'n4', label: 'd', type: null, depth: 2 },
            ])

        const { graphExpand } = await import('../graph-query.js')
        const r = await graphExpand({ workspaceId: WS, stimulus: 'x', width: 3 })
        expect(r.nodes).toHaveLength(3)
        expect(r.truncated).toBe(true)
    })
})

describe('getGraphMeta', () => {
    it('returns zeros when workspace has no concepts', async () => {
        mockExecute.mockResolvedValueOnce([{ node_count: 0, edge_count: 0, last_update: null }])
        const { getGraphMeta } = await import('../graph-query.js')
        const r = await getGraphMeta({ workspaceId: WS })
        expect(r).toEqual({ nodeCount: 0, edgeCount: 0, lastUpdate: null })
    })

    it('returns counts + lastUpdate when populated', async () => {
        const lastUpdate = new Date('2026-05-09T00:00:00Z')
        mockExecute.mockResolvedValueOnce([{ node_count: 7, edge_count: 12, last_update: lastUpdate }])
        const { getGraphMeta } = await import('../graph-query.js')
        const r = await getGraphMeta({ workspaceId: WS })
        expect(r).toEqual({ nodeCount: 7, edgeCount: 12, lastUpdate })
    })
})

describe('triggerGraphExtract', () => {
    it('returns ok=true', async () => {
        const { triggerGraphExtract } = await import('../graph-query.js')
        const r = await triggerGraphExtract({ workspaceId: WS, sourceLogId: 'src-1' })
        expect(r).toEqual({ ok: true })
        expect(mockExecute).not.toHaveBeenCalled()
    })
})
