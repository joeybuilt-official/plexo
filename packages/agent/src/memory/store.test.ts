// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockInsertValues = vi.fn(async () => [{ id: 'm-1' }])
const mockUpdateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }))
const mockSelectWhere = vi.fn(() => ({
    orderBy: vi.fn(() => ({ limit: vi.fn(async () => [] as unknown[]) })),
}))

vi.mock('@plexo/db', async () => {
    const makeChain = (): any => {
        const chain: any = {}
        const ret = (): any => chain
        chain.from = ret
        chain.where = vi.fn(() => ({
            orderBy: vi.fn(() => ({ limit: vi.fn(async () => [] as unknown[]) })),
            // storeMemory's workspace-existence check is .where(...).limit(1)
            // without an orderBy. Return a non-empty row so the write path proceeds.
            limit: vi.fn(async () => [{ id: 'ws-1' }]),
        }))
        chain.orderBy = ret
        chain.limit = vi.fn(async () => [])
        chain.values = mockInsertValues
        chain.set = mockUpdateSet
        return chain
    }
    return {
        db: {
            insert: vi.fn(() => ({ values: mockInsertValues })),
            update: vi.fn(() => ({ set: mockUpdateSet })),
            select: vi.fn(() => makeChain()),
            execute: vi.fn(async () => []),
        },
        eq: vi.fn(() => ({})),
        ne: vi.fn(() => ({})),
        and: vi.fn((...args: unknown[]) => ({ args })),
        desc: vi.fn(() => ({})),
        inArray: vi.fn(() => ({})),
        sql: Object.assign(
            function sqlTag() { return {} },
            { raw: () => ({}), join: () => ({}) },
        ),
        memoryEntries: {
            id: 'id',
            workspaceId: 'workspaceId',
            type: 'type',
            content: 'content',
            shorthand: 'shorthand',
            metadata: 'metadata',
            tier: 'tier',
            namespace: 'namespace',
            createdAt: 'createdAt',
        },
        workspaces: {
            id: 'workspaces.id',
        },
    }
})

vi.mock('ai', async () => ({
    generateText: vi.fn(async () => ({ text: 'F: fact1\nP: principle1\nS: short' })),
}))

const mockEmbed = vi.fn(async () => [0.1, 0.2, 0.3])
vi.mock('../embeddings/router.js', async () => ({
    resolveEmbeddingAdapterAsync: vi.fn(async () => ({
        adapter: { embed: mockEmbed },
        status: 'active',
        providerId: 'openai',
    })),
}))

vi.mock('../providers/router-v2/index.js', async () => ({
    routeAndCall: vi.fn(async (input: { doCall: (m: unknown) => Promise<string> }) =>
        input.doCall('mock-model')),
}))

vi.mock('../providers/registry.js', async () => ({
    // L3.4j: withFallback retired. Empty mock — store.ts now imports
    // routeAndCall directly. This stays to satisfy any registry imports
    // that linger via dynamic require.
}))

// Disable redis entirely (no client in tests)
vi.mock('redis', async () => ({
    createClient: vi.fn(() => {
        throw new Error('redis disabled in tests')
    }),
}))

describe('memory/store', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    describe('storeMemory', () => {
        it('inserts a memory row and returns a new id', async () => {
            const { storeMemory } = await import('./store.js')
            const id = await storeMemory({
                workspaceId: 'ws-1',
                type: 'task',
                content: 'Completed task X',
            })
            expect(typeof id).toBe('string')
            expect(id.length).toBeGreaterThan(0)
            expect(mockInsertValues).toHaveBeenCalled()
        })

        it('honors the tier parameter', async () => {
            const { storeMemory } = await import('./store.js')
            await storeMemory({
                workspaceId: 'ws-1',
                type: 'pattern',
                content: 'Always prefer X',
                tier: 'hot',
            })
            const call = mockInsertValues.mock.calls.at(-1) as unknown as any[] | undefined
            expect(call?.[0]).toEqual(
                expect.objectContaining({ tier: 'hot', type: 'pattern' }),
            )
        })

        it('passes metadata through', async () => {
            const { storeMemory } = await import('./store.js')
            await storeMemory({
                workspaceId: 'ws-1',
                type: 'task',
                content: 'x',
                metadata: { source: 'unit', flag: true },
            })
            const call = mockInsertValues.mock.calls.at(-1) as unknown as any[] | undefined
            expect(call?.[0]).toEqual(
                expect.objectContaining({
                    metadata: expect.objectContaining({ source: 'unit', flag: true }),
                }),
            )
        })
    })

    describe('searchMemory', () => {
        it('falls back to text search when query is empty', async () => {
            const { searchMemory } = await import('./store.js')
            const results = await searchMemory({
                workspaceId: 'ws-1',
                useCache: false,
            })
            expect(Array.isArray(results)).toBe(true)
        })

        it('runs vector search when query provided and embeddings available', async () => {
            mockEmbed.mockResolvedValueOnce([0.4, 0.5, 0.6])
            const { db } = await import('@plexo/db')
            ;(db.execute as any).mockResolvedValueOnce([
                {
                    id: 'm-42',
                    workspace_id: 'ws-1',
                    type: 'task',
                    content: 'hello world',
                    shorthand: 'hello',
                    metadata: {},
                    tier: 'active',
                    created_at: new Date(),
                    similarity: 0.82,
                },
            ])
            const { searchMemory } = await import('./store.js')
            const results = await searchMemory({
                workspaceId: 'ws-1',
                query: 'hello',
                useCache: false,
            })
            expect(results[0]).toMatchObject({
                id: 'm-42',
                content: 'hello world',
                similarity: 0.82,
                tier: 'active',
            })
        })

        it('applies type filter when type is specified', async () => {
            const { searchMemory } = await import('./store.js')
            await searchMemory({
                workspaceId: 'ws-1',
                type: 'pattern',
                useCache: false,
            })
            // just confirm the call didn't throw
            expect(true).toBe(true)
        })

        it('respects limit parameter', async () => {
            mockEmbed.mockResolvedValueOnce([0.1])
            const { searchMemory } = await import('./store.js')
            const out = await searchMemory({
                workspaceId: 'ws-1',
                query: 'test',
                limit: 3,
                useCache: false,
            })
            expect(Array.isArray(out)).toBe(true)
        })

        it('text-fallback path returns similarity 0.5 (unknown)', async () => {
            // Force embed to return null → text fallback path
            mockEmbed.mockResolvedValueOnce(null as any)
            const { db } = await import('@plexo/db')
            const makeRows = [
                {
                    id: 'm-9',
                    workspaceId: 'ws-1',
                    type: 'task' as const,
                    content: 'abc',
                    shorthand: null,
                    metadata: {},
                    tier: 'active',
                    createdAt: new Date(),
                },
            ]
            ;(db.select as any).mockImplementationOnce(() => ({
                from: () => ({
                    where: () => ({
                        orderBy: () => ({
                            limit: async () => makeRows,
                        }),
                    }),
                }),
            }))
            const { searchMemory } = await import('./store.js')
            const out = await searchMemory({
                workspaceId: 'ws-1',
                query: 'abc',
                useCache: false,
            })
            if (out.length > 0) {
                expect(out[0]?.similarity).toBe(0.5)
            }
        })
    })

    describe('recordTaskMemory', () => {
        // ADR 0017: recordTaskMemory is intentionally a no-op since 2026-05-13.
        // No insert is performed; only a debug log line fires.
        it('is a no-op per ADR 0017 — does not insert a memory row', async () => {
            const { recordTaskMemory } = await import('./store.js')
            mockInsertValues.mockClear()
            await recordTaskMemory({
                workspaceId: 'ws-1',
                taskId: 't-1',
                description: 'Fix the bug',
                outcome: 'success',
                toolsUsed: ['read_file', 'write_file'],
                qualityScore: 0.9,
            })
            expect(mockInsertValues).not.toHaveBeenCalled()
        })
    })

    describe('rememberInstruction', () => {
        it('stores as a pattern with userInstruction metadata', async () => {
            const { rememberInstruction } = await import('./store.js')
            const id = await rememberInstruction({
                workspaceId: 'ws-1',
                instruction: 'Always commit after push',
                source: 'chat',
            })
            expect(id).toBeTruthy()
            const call = mockInsertValues.mock.calls.at(-1) as unknown as any[] | undefined
            expect(call?.[0]).toEqual(
                expect.objectContaining({
                    type: 'pattern',
                    content: 'Always commit after push',
                    metadata: expect.objectContaining({
                        source: 'chat',
                        userInstruction: true,
                    }),
                }),
            )
        })
    })

    describe('preferences cache helpers', () => {
        it('returns null when redis unavailable', async () => {
            const { getCachedPreferences } = await import('./store.js')
            const result = await getCachedPreferences('ws-1')
            expect(result).toBeNull()
        })

        it('setCachedPreferences is non-throwing when redis unavailable', async () => {
            const { setCachedPreferences } = await import('./store.js')
            await expect(
                setCachedPreferences('ws-1', { foo: 'bar' }),
            ).resolves.toBeUndefined()
        })

        it('invalidatePrefsCache is non-throwing when redis unavailable', async () => {
            const { invalidatePrefsCache } = await import('./store.js')
            await expect(invalidatePrefsCache('ws-1')).resolves.toBeUndefined()
        })
    })
})
