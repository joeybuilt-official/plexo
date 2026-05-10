// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// `mirrorToGraphiti` writes via the analytics emitter; mock it before importing.
vi.mock('@plexo/db', () => ({
    db: { execute: vi.fn(async () => ({ rows: [] })) },
    sql: vi.fn(),
}))

const memoryAnalyticsEmits: Array<{ kind: string; payload: Record<string, unknown> }> = []
vi.mock('../../analytics/memory-events.js', () => ({
    emitMemoryWriteBackend: (payload: Record<string, unknown>) => memoryAnalyticsEmits.push({ kind: 'memory.write-backend', payload }),
    emitMemoryDivergence: (payload: Record<string, unknown>) => memoryAnalyticsEmits.push({ kind: 'memory.divergence', payload }),
}))

const {
    getWriteBackend,
    shouldWritePostgres,
    shouldMirrorGraphiti,
    mirrorToGraphiti,
    resetWriteBackendForTest,
    setWriteBackendClientForTest,
} = await import('../write-backend.js')

describe('getWriteBackend', () => {
    const orig = process.env.MEMORY_WRITE_BACKEND
    afterEach(() => {
        if (orig === undefined) delete process.env.MEMORY_WRITE_BACKEND
        else process.env.MEMORY_WRITE_BACKEND = orig
    })

    it('defaults to postgres when env unset', () => {
        delete process.env.MEMORY_WRITE_BACKEND
        expect(getWriteBackend()).toBe('postgres')
    })
    it('honors graphiti / dual / postgres', () => {
        process.env.MEMORY_WRITE_BACKEND = 'graphiti'
        expect(getWriteBackend()).toBe('graphiti')
        process.env.MEMORY_WRITE_BACKEND = 'dual'
        expect(getWriteBackend()).toBe('dual')
        process.env.MEMORY_WRITE_BACKEND = 'postgres'
        expect(getWriteBackend()).toBe('postgres')
    })
    it('case-insensitive', () => {
        process.env.MEMORY_WRITE_BACKEND = 'DUAL'
        expect(getWriteBackend()).toBe('dual')
    })
    it('falls back to postgres on invalid', () => {
        process.env.MEMORY_WRITE_BACKEND = 'kafka' as unknown as string
        expect(getWriteBackend()).toBe('postgres')
    })
})

describe('shouldWritePostgres / shouldMirrorGraphiti', () => {
    it('postgres mode: write postgres only', () => {
        expect(shouldWritePostgres('postgres')).toBe(true)
        expect(shouldMirrorGraphiti('postgres')).toBe(false)
    })
    it('dual mode: both', () => {
        expect(shouldWritePostgres('dual')).toBe(true)
        expect(shouldMirrorGraphiti('dual')).toBe(true)
    })
    it('graphiti mode: mirror only', () => {
        expect(shouldWritePostgres('graphiti')).toBe(false)
        expect(shouldMirrorGraphiti('graphiti')).toBe(true)
    })
})

describe('mirrorToGraphiti', () => {
    const WS = '00000000-0000-0000-0000-000000000001'
    beforeEach(() => {
        memoryAnalyticsEmits.length = 0
        resetWriteBackendForTest()
        // Make getClient() return null in default state by clearing env
        delete process.env.PLEXO_GRAPHITI_SIDECAR_URL
        delete process.env.PLEXO_SERVICE_KEY
        process.env.MEMORY_WRITE_BACKEND = 'dual'
    })

    it('returns ok=false + emits "bridge-not-configured" when env missing', async () => {
        const r = await mirrorToGraphiti({ workspaceId: WS, content: 'hello' })
        expect(r.ok).toBe(false)
        expect(r.episodeId).toBeNull()
        const evt = memoryAnalyticsEmits.find((e) => e.kind === 'memory.write-backend')
        expect(evt?.payload.reason).toBe('bridge-not-configured')
        expect(evt?.payload.graphitiOk).toBe(false)
    })

    it('returns the bridge response when client succeeds and emits success metric', async () => {
        const fakeClient = {
            addEpisode: vi.fn(async () => ({ episodeId: 'ep-1', extractedFactsCount: 2, extractedNodesCount: 3 })),
        } as unknown as Parameters<typeof setWriteBackendClientForTest>[0]
        setWriteBackendClientForTest(fakeClient)

        const r = await mirrorToGraphiti({
            workspaceId: WS,
            content: 'X likes Y',
            sourceDescription: 'app:plexo|src:test',
            triple: { subject: 'X', predicate: 'likes', object: 'Y' },
        })
        expect(r.ok).toBe(true)
        expect(r.episodeId).toBe('ep-1')
        expect(r.extractedFactsCount).toBe(2)
        const evt = memoryAnalyticsEmits.find((e) => e.kind === 'memory.write-backend')
        expect(evt?.payload.graphitiOk).toBe(true)
        expect(evt?.payload.episodeId).toBe('ep-1')
        expect(evt?.payload.extractedFacts).toBe(2)
    })

    it('returns ok=false + emits "bridge-error" reason when client returns null', async () => {
        const fakeClient = {
            addEpisode: vi.fn(async () => null),
        } as unknown as Parameters<typeof setWriteBackendClientForTest>[0]
        setWriteBackendClientForTest(fakeClient)

        const r = await mirrorToGraphiti({ workspaceId: WS, content: 'hello' })
        expect(r.ok).toBe(false)
        const evt = memoryAnalyticsEmits.find((e) => e.kind === 'memory.write-backend')
        expect(evt?.payload.reason).toBe('bridge-error')
    })

    it('forwards triple as source_metadata.triple to the bridge', async () => {
        const fakeClient = {
            addEpisode: vi.fn(async () => ({ episodeId: 'ep-2', extractedFactsCount: 1, extractedNodesCount: 1 })),
        }
        setWriteBackendClientForTest(fakeClient as unknown as Parameters<typeof setWriteBackendClientForTest>[0])

        await mirrorToGraphiti({
            workspaceId: WS,
            content: 'X likes Y',
            triple: { subject: 'X', predicate: 'likes', object: 'Y' },
            metadata: { foo: 'bar' },
        })
        expect(fakeClient.addEpisode).toHaveBeenCalledTimes(1)
        const calls = fakeClient.addEpisode.mock.calls as unknown as Array<[{ sourceMetadata: Record<string, unknown> }]>
        const arg = calls[0]![0]
        expect(arg.sourceMetadata.foo).toBe('bar')
        expect(arg.sourceMetadata.triple).toEqual({ subject: 'X', predicate: 'likes', object: 'Y' })
    })
})
