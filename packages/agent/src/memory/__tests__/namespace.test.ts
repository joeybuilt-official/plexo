// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 10 — Memory namespacing tests.
 *
 * These tests cover two layers:
 *
 *  1. The pure namespace helpers in `namespace.ts` — default resolution,
 *     agent-specific slices, the shared-slice special case, and the
 *     multi-namespace helper used for cross-namespace reads.
 *
 *  2. `storeMemory` / `searchMemory` / `writeShared` namespace wiring, by
 *     mocking `@plexo/db` and asserting the values that the memory store
 *     actually sends into the insert/query layer. This is the same style
 *     as the sibling `store.test.ts` — no real DB required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
    DEFAULT_NAMESPACE,
    SHARED_NAMESPACE,
    defaultNamespaceForAgent,
    sharedNamespaces,
    isSharedNamespace,
} from '../namespace.js'

// ── Mocks — parallel the setup used by the sibling store.test.ts ────────────

const mockInsertValues = vi.fn(async () => [{ id: 'm-1' }])
const mockUpdateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }))

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

// ADR-0045 Phase 2: store.ts imports operators from drizzle-orm directly, so
// the operator spies (asserted via `import('drizzle-orm')`) live here.
vi.mock('drizzle-orm', async (importOriginal) => ({
    ...(await importOriginal<typeof import('drizzle-orm')>()),
    eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
    ne: vi.fn((col: unknown, val: unknown) => ({ op: 'ne', col, val })),
    and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
    desc: vi.fn(() => ({})),
    inArray: vi.fn((col: unknown, vals: unknown) => ({ op: 'inArray', col, vals })),
    sql: Object.assign(
        function sqlTag() { return {} },
        { raw: () => ({}), join: () => ({}) },
    ),
}))

vi.mock('ai', async () => ({
    generateText: vi.fn(async () => ({ text: 'F: f1\nP: p1\nS: s1' })),
}))

const mockEmbed = vi.fn(async () => null as number[] | null)
vi.mock('../../embeddings/router.js', async () => ({
    resolveEmbeddingAdapterAsync: vi.fn(async () => ({
        adapter: { embed: mockEmbed },
        status: 'active',
        providerId: 'openai',
    })),
}))

vi.mock('../../providers/router-v2/index.js', async () => ({
    routeAndCall: vi.fn(async (input: { doCall: (m: unknown) => Promise<string> }) =>
        input.doCall('mock-model')),
}))

vi.mock('../../providers/registry.js', async () => ({
    // L3.4j: withFallback retired. Empty mock for any lingering registry imports.
}))

vi.mock('redis', async () => ({
    createClient: vi.fn(() => { throw new Error('redis disabled in tests') }),
}))

// Phase 5 closure: shouldWritePostgres is always false in production.
// Force postgres path so these tests exercise the insert logic.
vi.mock('../write-backend.js', () => ({
    getWriteBackend: () => 'postgres',
    shouldWritePostgres: () => true,
}))

// ── Pure helper tests ───────────────────────────────────────────────────────

describe('memory/namespace helpers', () => {
    it('returns the literal default namespace when no agent id is provided', () => {
        expect(defaultNamespaceForAgent()).toBe(DEFAULT_NAMESPACE)
        expect(defaultNamespaceForAgent(undefined)).toBe(DEFAULT_NAMESPACE)
        expect(defaultNamespaceForAgent(null)).toBe(DEFAULT_NAMESPACE)
        expect(defaultNamespaceForAgent('')).toBe(DEFAULT_NAMESPACE)
        expect(defaultNamespaceForAgent('   ')).toBe(DEFAULT_NAMESPACE)
    })

    it('prefixes per-agent namespaces with agent-', () => {
        expect(defaultNamespaceForAgent('alpha')).toBe('agent-alpha')
        expect(defaultNamespaceForAgent('research-bot')).toBe('agent-research-bot')
    })

    it('sharedNamespaces spans per-agent slice + shared slice', () => {
        expect(sharedNamespaces('alpha')).toEqual(['agent-alpha', SHARED_NAMESPACE])
        expect(sharedNamespaces()).toEqual([DEFAULT_NAMESPACE, SHARED_NAMESPACE])
    })

    it('isSharedNamespace only matches the literal shared slice', () => {
        expect(isSharedNamespace(SHARED_NAMESPACE)).toBe(true)
        expect(isSharedNamespace('shared')).toBe(true)
        expect(isSharedNamespace('default')).toBe(false)
        expect(isSharedNamespace('agent-alpha')).toBe(false)
        expect(isSharedNamespace(undefined)).toBe(false)
    })
})

// ── Store integration tests (mocked db) ─────────────────────────────────────

describe('memory/store namespace wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockEmbed.mockResolvedValue(null) // force text-fallback path for searches
    })

    it('storeMemory defaults to the "default" namespace when no agent id is passed', async () => {
        const { storeMemory } = await import('../store.js')
        await storeMemory({
            workspaceId: 'ws-1',
            type: 'task',
            content: 'default-slice entry',
        })
        const call = mockInsertValues.mock.calls.at(-1) as unknown as any[] | undefined
        expect(call?.[0]).toEqual(
            expect.objectContaining({
                namespace: DEFAULT_NAMESPACE,
                type: 'task',
            }),
        )
    })

    it('storeMemory derives agent-<id> namespace when agentId is supplied', async () => {
        const { storeMemory } = await import('../store.js')
        await storeMemory({
            workspaceId: 'ws-1',
            type: 'pattern',
            content: 'agent-slice entry',
            agentId: 'alpha',
        })
        const call = mockInsertValues.mock.calls.at(-1) as unknown as any[] | undefined
        expect(call?.[0]).toEqual(
            expect.objectContaining({
                namespace: 'agent-alpha',
                type: 'pattern',
            }),
        )
    })

    it('two agents writing in the same workspace land in isolated namespaces', async () => {
        const { storeMemory } = await import('../store.js')
        await storeMemory({
            workspaceId: 'ws-1',
            type: 'task',
            content: 'alpha memory',
            agentId: 'alpha',
        })
        await storeMemory({
            workspaceId: 'ws-1',
            type: 'task',
            content: 'beta memory',
            agentId: 'beta',
        })
        const calls = mockInsertValues.mock.calls as unknown as Array<Array<{ namespace: string }>>
        const nsValues = calls.map((c) => c[0]!.namespace)
        expect(nsValues).toEqual(expect.arrayContaining(['agent-alpha', 'agent-beta']))
        expect(new Set(nsValues).size).toBe(2)
    })

    it('storeMemory rejects the shared namespace and coerces to default', async () => {
        const { storeMemory } = await import('../store.js')
        await storeMemory({
            workspaceId: 'ws-1',
            type: 'pattern',
            content: 'should not land in shared',
            namespace: SHARED_NAMESPACE,
        })
        const call = mockInsertValues.mock.calls.at(-1) as unknown as any[] | undefined
        expect(call?.[0]).toEqual(
            expect.objectContaining({ namespace: DEFAULT_NAMESPACE }),
        )
    })

    it('writeShared writes into the shared namespace and tags the author', async () => {
        const { writeShared } = await import('../store.js')
        await writeShared({
            workspaceId: 'ws-1',
            type: 'pattern',
            content: 'cross-agent truth',
            authorAgentId: 'alpha',
        })
        const call = mockInsertValues.mock.calls.at(-1) as unknown as any[] | undefined
        expect(call?.[0]).toEqual(
            expect.objectContaining({
                namespace: SHARED_NAMESPACE,
                metadata: expect.objectContaining({ sharedBy: 'alpha' }),
            }),
        )
    })

    it('searchMemory with no namespace falls back to the default slice (backward compat)', async () => {
        const { searchMemory } = await import('../store.js')
        await searchMemory({ workspaceId: 'ws-1', useCache: false })
        const { inArray } = await import('drizzle-orm')
        const inArrayCalls = (inArray as unknown as ReturnType<typeof vi.fn>).mock.calls
        expect(inArrayCalls.length).toBeGreaterThan(0)
        const lastVals = inArrayCalls.at(-1)?.[1]
        expect(lastVals).toEqual([DEFAULT_NAMESPACE])
    })

    it('searchMemory with agentId spans [agent-<id>, shared] for cross-namespace reads', async () => {
        const { searchMemory } = await import('../store.js')
        await searchMemory({
            workspaceId: 'ws-1',
            agentId: 'alpha',
            useCache: false,
        })
        const { inArray } = await import('drizzle-orm')
        const inArrayCalls = (inArray as unknown as ReturnType<typeof vi.fn>).mock.calls
        const lastVals = inArrayCalls.at(-1)?.[1]
        expect(lastVals).toEqual(['agent-alpha', SHARED_NAMESPACE])
    })

    it('searchMemory honors an explicit namespaces[] list verbatim', async () => {
        const { searchMemory } = await import('../store.js')
        await searchMemory({
            workspaceId: 'ws-1',
            namespaces: ['agent-alpha', 'agent-beta', SHARED_NAMESPACE],
            useCache: false,
        })
        const { inArray } = await import('drizzle-orm')
        const inArrayCalls = (inArray as unknown as ReturnType<typeof vi.fn>).mock.calls
        const lastVals = inArrayCalls.at(-1)?.[1]
        expect(lastVals).toEqual(['agent-alpha', 'agent-beta', SHARED_NAMESPACE])
    })
})
