// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Owned-workspace resolution — the two repository functions that decide WHICH
 * Plexo workspace a user's apps bind to.
 *
 * `getOwnedWorkspaceIdName` backs `POST /api/v1/auth/workspace/ensure`.
 * `getOwnedWorkspaceId` backs `POST /api/v1/auth/profiles/auto-attach-user`.
 * Both delegate to one private ordered helper, so they cannot disagree.
 *
 * Pins:
 *   1. Both queries are ORDERED oldest-first by (created_at, id) — the
 *      regression guard. An unordered `LIMIT 1` lets Postgres return any owned
 *      row, so an app could silently rebind between calls.
 *   2. `id` is a secondary tiebreak, so the result is fully deterministic and
 *      not merely "stable in practice".
 *   3. Both resolvers share ONE ordering policy (a single ordered query per
 *      call), so fixing one cannot leave the other ambiguous.
 *   4. Return shapes and the no-workspace case.
 *
 * Why this has a test at all: Levio lost ~6 weeks of email + calendar sync
 * (2026-08-11 -> 2026-09-26) because its operator owned two workspaces and
 * ensure() resolved the one with no Google token. Every layer reported healthy.
 * Ordering is the whole fix, so it is the whole contract — removing it must
 * fail here rather than in production. Verified: deleting the `orderBy` turns
 * cases 1-3 red while the shape cases stay green.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Captured query shape ────────────────────────────────────────────────────

const ctl = {
    rows: [] as Array<{ id: string; name: string }>,
    orderByArgs: null as unknown[] | null,
    orderByCalls: 0,
    limitArgs: null as unknown[] | null,
    whereCalls: 0,
}

// `asc` must be observable so we can assert WHICH columns are ordered and in
// what direction, not merely that some orderBy happened.
const ascMock = vi.fn((col: unknown) => ({ kind: 'asc', col }))

vi.mock('drizzle-orm', () => ({
    eq: vi.fn((a: unknown, b: unknown) => ({ kind: 'eq', a, b })),
    inArray: vi.fn(),
    and: vi.fn(),
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
        { join: vi.fn() },
    ),
    asc: ascMock,
}))

vi.mock('@plexo/db', () => {
    const limit = vi.fn(async (...args: unknown[]) => {
        ctl.limitArgs = args
        return ctl.rows
    })
    const orderBy = vi.fn((...args: unknown[]) => {
        ctl.orderByCalls += 1
        ctl.orderByArgs = args
        return { limit }
    })
    const where = vi.fn(() => {
        ctl.whereCalls += 1
        return { orderBy, limit }
    })
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    return {
        db: { select },
        // Stable sentinel identities so we can assert the ordered columns are
        // exactly workspaces.createdAt then workspaces.id.
        workspaces: {
            id: 'workspaces.id',
            name: 'workspaces.name',
            ownerId: 'workspaces.owner_id',
            createdAt: 'workspaces.created_at',
        },
        workspaceMembers: {},
        installedConnections: {},
        connectionsRegistry: {},
        extensions: {},
        appProfiles: {},
        DEFAULT_INTELLIGENCE_SETTINGS: {},
        DEFAULT_WORKSPACE_SETTINGS: {},
    }
})

const { getOwnedWorkspaceIdName, getOwnedWorkspaceId } = await import('../auth.repository.js')

const USER = 'f9b6ed66-8e40-49e1-a439-22e6d25aea37'

beforeEach(() => {
    vi.clearAllMocks()
    ctl.rows = []
    ctl.orderByArgs = null
    ctl.orderByCalls = 0
    ctl.limitArgs = null
    ctl.whereCalls = 0
})

/** The ordering contract both resolvers must satisfy. */
function expectOldestFirstOrdering() {
    expect(ctl.orderByCalls).toBe(1)
    expect(ctl.orderByArgs).not.toBeNull()
    // Primary sort: creation time, ascending — oldest first, so the personal
    // workspace the user set up by hand wins over app-created ones.
    expect(ctl.orderByArgs![0]).toEqual({ kind: 'asc', col: 'workspaces.created_at' })
    // Secondary: id, so a same-instant tie is still fully deterministic.
    expect(ctl.orderByArgs).toHaveLength(2)
    expect(ctl.orderByArgs![1]).toEqual({ kind: 'asc', col: 'workspaces.id' })
}

describe('getOwnedWorkspaceIdName (workspace/ensure)', () => {
    it('orders by created_at ASC so the oldest (personal) workspace wins', async () => {
        ctl.rows = [{ id: 'ws-personal', name: 'Personal' }]

        const result = await getOwnedWorkspaceIdName(USER)

        expectOldestFirstOrdering()
        expect(result).toEqual({ id: 'ws-personal', name: 'Personal' })
    })

    it('still limits to a single row', async () => {
        ctl.rows = [{ id: 'ws-personal', name: 'Personal' }]

        await getOwnedWorkspaceIdName(USER)

        expect(ctl.limitArgs).toEqual([1])
    })

    it('scopes the lookup to the owning user', async () => {
        ctl.rows = []

        await getOwnedWorkspaceIdName(USER)

        expect(ctl.whereCalls).toBe(1)
    })

    it('returns undefined when the user owns no workspace', async () => {
        ctl.rows = []

        expect(await getOwnedWorkspaceIdName(USER)).toBeUndefined()
    })

    it('returns the first resolved row when the user owns several', async () => {
        // The mock returns exactly what the ordered query would: the caller must
        // take the first, not merge or pick arbitrarily.
        ctl.rows = [
            { id: 'ws-personal', name: 'Personal' },
            { id: 'ws-fylo', name: 'Fylo' },
        ]

        expect(await getOwnedWorkspaceIdName(USER)).toEqual({ id: 'ws-personal', name: 'Personal' })
    })
})

describe('getOwnedWorkspaceId (auto-attach-user)', () => {
    it('applies the SAME ordering contract as workspace/ensure', async () => {
        ctl.rows = [{ id: 'ws-personal', name: 'Personal' }]

        const result = await getOwnedWorkspaceId(USER)

        // auto-attach-user installs the app's connection + bridge extension into
        // whichever workspace this resolves. An unordered pick makes the app's
        // tools invisible in the workspace the user actually works in.
        expectOldestFirstOrdering()
        expect(result).toEqual({ id: 'ws-personal' })
    })

    it('returns only the id, dropping the name', async () => {
        ctl.rows = [{ id: 'ws-personal', name: 'Personal' }]

        const result = await getOwnedWorkspaceId(USER)

        expect(result).toEqual({ id: 'ws-personal' })
        expect(Object.keys(result!)).toEqual(['id'])
    })

    it('returns undefined when the user owns no workspace', async () => {
        ctl.rows = []

        expect(await getOwnedWorkspaceId(USER)).toBeUndefined()
    })
})

describe('both resolvers share one ordering policy', () => {
    it('resolves to the SAME workspace, whichever entry point asks', async () => {
        // The incident shape: oldest = Personal (real connections), newest =
        // Fylo (auto-installed app profiles only). Both entry points must agree,
        // or ensure() and auto-attach-user() bind the app to different
        // workspaces.
        ctl.rows = [
            { id: 'ws-personal', name: 'Personal' },
            { id: 'ws-fylo', name: 'Fylo' },
        ]

        const fromEnsure = await getOwnedWorkspaceIdName(USER)
        const firstOrderByArgs = ctl.orderByArgs

        ctl.orderByCalls = 0
        ctl.orderByArgs = null
        const fromAutoAttach = await getOwnedWorkspaceId(USER)

        expect(fromEnsure!.id).toBe('ws-personal')
        expect(fromAutoAttach!.id).toBe('ws-personal')
        // Identical ordering, i.e. one shared policy rather than two copies.
        expect(ctl.orderByArgs).toEqual(firstOrderByArgs)
        expect(ctl.orderByCalls).toBe(1)
    })
})
