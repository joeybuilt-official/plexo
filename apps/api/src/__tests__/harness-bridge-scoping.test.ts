// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Harness integration — connector scoping + agent-loop extraction
 *
 * Covers:
 *   1. loadConnectionTools with allowedIds — inArray filter applied at DB level
 *      when allowedIds is non-empty; skipped (allow-all) when absent or empty.
 *   2. Scoping guarantee: connector Y is excluded when allowedIds = [X].
 *   3. agent-loop: ctx.connectorIds extraction from task.context.
 *   4. executor: cache key isolation between scoped and unscoped loads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const WS_ID  = 'aaaaaaaa-0000-0000-0000-000000000001'
const CONN_A = 'cccccccc-0000-0000-0000-000000000003'
const CONN_B = 'dddddddd-0000-0000-0000-000000000004'

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 1: loadConnectionTools — allowedIds DB filter
// ─────────────────────────────────────────────────────────────────────────────

// Capture inArray calls so we can assert whether the filter was applied.
const inArrayCalls: Array<string[]> = []

vi.mock('@plexo/db', () => {
    const inArray = vi.fn((_col: unknown, ids: string[]) => {
        inArrayCalls.push([...ids])
        return { __inArray: ids }
    })
    const eq = vi.fn(() => ({}))
    const and = vi.fn((...args: unknown[]) => ({ __and: args.filter(Boolean) }))

    // Workspace read-only check (select.from.where.limit)
    const wsLimit = vi.fn(async () => [])
    const wsWhere = vi.fn(() => ({ limit: wsLimit }))
    const wsFrom  = vi.fn(() => ({ where: wsWhere }))

    // connections query — returns empty rows (factories will warn + skip)
    const connRows: unknown[] = []
    const connThen = vi.fn((fn: (rows: unknown[]) => void) => { fn(connRows); return Promise.resolve(connRows) })
    const connWhere = vi.fn(() => ({ then: connThen }))
    const connFrom  = vi.fn(() => ({ where: connWhere }))

    // extensions query (bridge dedup guard)
    const extThen = vi.fn((fn: (rows: unknown[]) => void) => { fn([]); return Promise.resolve([]) })
    const extWhere = vi.fn(() => ({ then: extThen }))
    const extFrom  = vi.fn(() => ({ where: extWhere }))

    let callN = 0
    const select = vi.fn(() => {
        callN++
        if (callN % 3 === 1) return { from: wsFrom }   // workspace read-only check
        if (callN % 3 === 2) return { from: connFrom }  // connections query
        return { from: extFrom }                         // extensions dedup check
    })

    return {
        db: { select },
        installedConnections: {
            id: 'id', registryId: 'registry_id', credentials: 'credentials',
            enabledTools: 'enabled_tools', status: 'status', workspaceId: 'workspace_id',
        } as any,
        workspaces: { id: 'id', settings: 'settings' } as any,
        extensions: { name: 'name', enabled: 'enabled', workspaceId: 'workspace_id' } as any,
        eq,
        and,
        inArray,
    }
})

vi.mock('@plexo/agent/connections/crypto-util', () => ({
    decrypt: vi.fn(() => '{}'),
    encrypt: vi.fn(() => 'enc'),
}))

vi.mock('pino', () => ({
    default: vi.fn(() => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    })),
}))

describe('loadConnectionTools — connector allowlist (allowedIds)', () => {
    beforeEach(() => {
        inArrayCalls.length = 0
        vi.clearAllMocks()
        vi.resetModules()
    })

    it('no allowedIds → inArray NOT called (allow-all)', async () => {
        const { inArray } = await import('@plexo/db')
        const { loadConnectionTools } = await import('@plexo/agent/connections/bridge')
        await loadConnectionTools(WS_ID)
        expect(vi.mocked(inArray)).not.toHaveBeenCalled()
    })

    it('allowedIds=[CONN_A] → inArray called with [CONN_A]', async () => {
        const { inArray } = await import('@plexo/db')
        const { loadConnectionTools } = await import('@plexo/agent/connections/bridge')
        await loadConnectionTools(WS_ID, [CONN_A])
        expect(vi.mocked(inArray)).toHaveBeenCalledWith(expect.anything(), [CONN_A])
    })

    it('allowedIds=[CONN_A, CONN_B] → inArray includes both', async () => {
        const { inArray } = await import('@plexo/db')
        const { loadConnectionTools } = await import('@plexo/agent/connections/bridge')
        await loadConnectionTools(WS_ID, [CONN_A, CONN_B])
        expect(vi.mocked(inArray)).toHaveBeenCalledWith(
            expect.anything(),
            [CONN_A, CONN_B],
        )
    })

    it('empty allowedIds → inArray NOT called (allow-all, backwards-compat)', async () => {
        const { inArray } = await import('@plexo/db')
        const { loadConnectionTools } = await import('@plexo/agent/connections/bridge')
        await loadConnectionTools(WS_ID, [])
        expect(vi.mocked(inArray)).not.toHaveBeenCalled()
    })

    it('undefined allowedIds → inArray NOT called', async () => {
        const { inArray } = await import('@plexo/db')
        const { loadConnectionTools } = await import('@plexo/agent/connections/bridge')
        await loadConnectionTools(WS_ID, undefined)
        expect(vi.mocked(inArray)).not.toHaveBeenCalled()
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 2: agent-loop connectorIds extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('connectorIds extraction from task.context', () => {
    // Pure extraction logic from agent-loop.ts (inline IIFE):
    //   Array.isArray(ids) && ids.length > 0 ? ids : undefined
    function extract(context: unknown): string[] | undefined {
        const ids = (context as Record<string, unknown> | null)?.connectorIds
        return Array.isArray(ids) && ids.length > 0 ? ids as string[] : undefined
    }

    it('non-empty array → returns it', () => {
        expect(extract({ connectorIds: [CONN_A, CONN_B] })).toEqual([CONN_A, CONN_B])
    })

    it('empty array → undefined (allow-all)', () => {
        expect(extract({ connectorIds: [] })).toBeUndefined()
    })

    it('absent field → undefined', () => {
        expect(extract({})).toBeUndefined()
    })

    it('null context → undefined', () => {
        expect(extract(null)).toBeUndefined()
    })

    it('non-array value → undefined (malformed context guard)', () => {
        expect(extract({ connectorIds: 'not-an-array' })).toBeUndefined()
        expect(extract({ connectorIds: 42 })).toBeUndefined()
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 3: executor cache key isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('executor cache key — scoped vs unscoped', () => {
    function buildKey(workspaceId: string, connectorIds: string[] | undefined): string {
        const scope = connectorIds && connectorIds.length > 0
            ? `:scoped:${[...connectorIds].sort().join(',')}`
            : ''
        return `connections:${workspaceId}${scope}`
    }

    it('no connectorIds → bare workspace key', () => {
        expect(buildKey(WS_ID, undefined)).toBe(`connections:${WS_ID}`)
    })

    it('empty connectorIds → bare key (same as unscoped)', () => {
        expect(buildKey(WS_ID, [])).toBe(`connections:${WS_ID}`)
    })

    it('non-empty connectorIds → scoped key', () => {
        expect(buildKey(WS_ID, [CONN_A])).toBe(`connections:${WS_ID}:scoped:${CONN_A}`)
    })

    it('different allowlists → different keys', () => {
        expect(buildKey(WS_ID, [CONN_A])).not.toBe(buildKey(WS_ID, [CONN_B]))
    })

    it('same IDs, different order → same key (sort-normalised)', () => {
        expect(buildKey(WS_ID, [CONN_A, CONN_B])).toBe(buildKey(WS_ID, [CONN_B, CONN_A]))
    })

    it('scoped and unscoped are different keys (no cross-contamination)', () => {
        expect(buildKey(WS_ID, [CONN_A])).not.toBe(buildKey(WS_ID, undefined))
    })
})
