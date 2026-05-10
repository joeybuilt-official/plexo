// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
    getReadBackend,
    readFromGraphiti,
    resetReadBackendForTest,
    setReadBackendClientForTest,
} from '../read-backend.js'
import type { GraphitiClient } from '@plexo/graphiti-bridge'

const WS = '00000000-0000-0000-0000-000000000001'

describe('getReadBackend', () => {
    const orig = process.env.MEMORY_READ_BACKEND
    afterEach(() => {
        if (orig === undefined) delete process.env.MEMORY_READ_BACKEND
        else process.env.MEMORY_READ_BACKEND = orig
    })

    it('defaults to postgres when env unset', () => {
        delete process.env.MEMORY_READ_BACKEND
        expect(getReadBackend()).toBe('postgres')
    })
    it('honors graphiti / postgres', () => {
        process.env.MEMORY_READ_BACKEND = 'graphiti'
        expect(getReadBackend()).toBe('graphiti')
        process.env.MEMORY_READ_BACKEND = 'postgres'
        expect(getReadBackend()).toBe('postgres')
    })
    it('case-insensitive', () => {
        process.env.MEMORY_READ_BACKEND = 'GRAPHITI'
        expect(getReadBackend()).toBe('graphiti')
    })
    it('falls back to postgres on invalid', () => {
        process.env.MEMORY_READ_BACKEND = 'kafka' as unknown as string
        expect(getReadBackend()).toBe('postgres')
    })
})

describe('readFromGraphiti', () => {
    beforeEach(() => {
        resetReadBackendForTest()
        delete process.env.PLEXO_GRAPHITI_SIDECAR_URL
        delete process.env.PLEXO_SERVICE_KEY
    })

    it('returns null when bridge not configured (caller falls back to postgres)', async () => {
        const r = await readFromGraphiti({ workspaceId: WS, queryText: 'hi', limit: 5 })
        expect(r).toBeNull()
    })

    it('returns null when bridge.search returns null (caller falls back to postgres)', async () => {
        const fake = { search: async () => null } as unknown as GraphitiClient
        setReadBackendClientForTest(fake)
        const r = await readFromGraphiti({ workspaceId: WS, queryText: 'hi', limit: 5 })
        expect(r).toBeNull()
    })

    it('returns empty array when search succeeded with no edges (NOT a fallback signal)', async () => {
        const fake = { search: async () => ({ results: [] }) } as unknown as GraphitiClient
        setReadBackendClientForTest(fake)
        const r = await readFromGraphiti({ workspaceId: WS, queryText: 'hi', limit: 5 })
        expect(r).toEqual([])
    })

    it('maps Graphiti edges into MemorySearchResult shape', async () => {
        const fake = {
            search: async () => ({
                results: [
                    {
                        uuid: 'edge-1',
                        fact: 'X likes Y',
                        source_node_uuid: 'n-1',
                        target_node_uuid: 'n-2',
                        valid_at: '2026-05-01T00:00:00.000Z',
                        invalid_at: null,
                        created_at: '2026-05-01T00:00:00.000Z',
                    },
                ],
            }),
        } as unknown as GraphitiClient
        setReadBackendClientForTest(fake)

        const r = await readFromGraphiti({ workspaceId: WS, queryText: 'likes', limit: 5 })
        expect(r).toHaveLength(1)
        const row = r![0]!
        expect(row.id).toBe('edge-1')
        expect(row.workspaceId).toBe(WS)
        expect(row.type).toBe('pattern')
        expect(row.content).toBe('X likes Y')
        expect(row.tier).toBe('active')
        expect(row.namespace).toBe('default')
        expect(row.similarity).toBe(1)
        expect(row.metadata.graphiti_uuid).toBe('edge-1')
        expect(row.metadata.source_node_uuid).toBe('n-1')
        expect(row.metadata.target_node_uuid).toBe('n-2')
        expect(row.createdAt instanceof Date).toBe(true)
    })

    it('forwards limit as numResults to bridge.search', async () => {
        let captured: { numResults?: number } | null = null
        const fake = {
            search: async (req: { numResults?: number }) => {
                captured = req
                return { results: [] }
            },
        } as unknown as GraphitiClient
        setReadBackendClientForTest(fake)

        await readFromGraphiti({ workspaceId: WS, queryText: 'q', limit: 25 })
        expect(captured!.numResults).toBe(25)
    })
})
