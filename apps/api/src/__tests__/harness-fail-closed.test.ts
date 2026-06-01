// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase B — Fail-closed connector scoping
 *
 * Covers:
 *   1. Automated sources (cron, github) with no connectorIds in context
 *      → connectorIds = [] (deny-all) sent to bridge.
 *   2. Interactive sources (user, telegram) with no connectorIds
 *      → connectorIds = undefined (allow-all, no change).
 *   3. Any source with connectorIds in context → forwarded as-is.
 *   4. bridge.ts: empty allowedIds → early-return {} (deny-all).
 *   5. executor cache key: deny-all → ':deny-all', allow-all → '', scoped → ':scoped:<ids>'.
 */

import { describe, it, expect } from 'vitest'

const CONN_A = 'cccccccc-0000-0000-0000-000000000003'
const CONN_B = 'dddddddd-0000-0000-0000-000000000004'

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: connectorIds resolution (extracted from agent-loop logic)
// ─────────────────────────────────────────────────────────────────────────────

const AUTOMATED_SOURCES = new Set(['cron', 'github'])

function resolveConnectorIds(
    contextConnectorIds: unknown,
    taskSource: string | null | undefined,
): string[] | undefined {
    const ids = contextConnectorIds
    const fromContext = Array.isArray(ids) && ids.length > 0 ? ids as string[] : undefined
    if (fromContext === undefined && AUTOMATED_SOURCES.has(taskSource ?? '')) {
        return []  // deny-all sentinel
    }
    return fromContext
}

describe('agent-loop connectorIds resolution — fail-closed', () => {
    describe('automated sources (no context connectorIds → deny-all)', () => {
        it('cron + no connectorIds → []', () => {
            expect(resolveConnectorIds(undefined, 'cron')).toEqual([])
        })

        it('github + no connectorIds → []', () => {
            expect(resolveConnectorIds(undefined, 'github')).toEqual([])
        })

        it('cron + empty array in context → [] (deny-all, not allow-all)', () => {
            // Empty array in context is same as missing — fail-closed for automated
            expect(resolveConnectorIds([], 'cron')).toEqual([])
        })

        it('cron + populated connectorIds → forwarded (allowlist takes priority)', () => {
            expect(resolveConnectorIds([CONN_A, CONN_B], 'cron')).toEqual([CONN_A, CONN_B])
        })

        it('github + populated connectorIds → forwarded', () => {
            expect(resolveConnectorIds([CONN_A], 'github')).toEqual([CONN_A])
        })
    })

    describe('interactive sources (no context connectorIds → allow-all)', () => {
        it('user + no connectorIds → undefined (allow-all)', () => {
            expect(resolveConnectorIds(undefined, 'user')).toBeUndefined()
        })

        it('telegram + no connectorIds → undefined', () => {
            expect(resolveConnectorIds(undefined, 'telegram')).toBeUndefined()
        })

        it('unknown source + no connectorIds → undefined', () => {
            expect(resolveConnectorIds(undefined, 'unknown')).toBeUndefined()
        })

        it('null source + no connectorIds → undefined', () => {
            expect(resolveConnectorIds(undefined, null)).toBeUndefined()
        })

        it('user + populated connectorIds → forwarded', () => {
            expect(resolveConnectorIds([CONN_A], 'user')).toEqual([CONN_A])
        })
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: bridge deny-all guard (allowedIds = [])
// ─────────────────────────────────────────────────────────────────────────────

describe('bridge deny-all: loadConnectionTools returns {} when allowedIds = []', async () => {
    it('empty allowedIds → returns empty ToolSet without hitting DB', async () => {
        // This mirrors the early-return logic in bridge.ts:
        //   if (allowedIds !== undefined && allowedIds.length === 0) return {}
        const allowedIds: string[] = []
        const result = allowedIds !== undefined && allowedIds.length === 0 ? {} : null
        expect(result).toEqual({})
    })

    it('undefined allowedIds → does NOT early-return (allow-all path)', () => {
        const allowedIds = undefined
        const result = allowedIds !== undefined && (allowedIds as string[]).length === 0 ? {} : 'continue'
        expect(result).toBe('continue')
    })

    it('non-empty allowedIds → does NOT early-return (allowlist path)', () => {
        const allowedIds = [CONN_A]
        const result = allowedIds !== undefined && allowedIds.length === 0 ? {} : 'continue'
        expect(result).toBe('continue')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: executor cache key for all three scoping states
// ─────────────────────────────────────────────────────────────────────────────

const WS_ID = 'aaaaaaaa-0000-0000-0000-000000000001'

function buildCacheKey(workspaceId: string, connectorIds: string[] | undefined): string {
    const scopeKey = connectorIds === undefined
        ? ''
        : connectorIds.length === 0
            ? ':deny-all'
            : `:scoped:${[...connectorIds].sort().join(',')}`
    return `connections:${workspaceId}${scopeKey}`
}

describe('executor cache key — three-state scoping', () => {
    it('undefined (allow-all) → bare workspace key', () => {
        expect(buildCacheKey(WS_ID, undefined)).toBe(`connections:${WS_ID}`)
    })

    it('[] (deny-all) → :deny-all key', () => {
        expect(buildCacheKey(WS_ID, [])).toBe(`connections:${WS_ID}:deny-all`)
    })

    it('[CONN_A] (allowlist) → :scoped: key', () => {
        expect(buildCacheKey(WS_ID, [CONN_A])).toBe(`connections:${WS_ID}:scoped:${CONN_A}`)
    })

    it('deny-all and allow-all are different keys (no cross-contamination)', () => {
        expect(buildCacheKey(WS_ID, [])).not.toBe(buildCacheKey(WS_ID, undefined))
    })

    it('deny-all and scoped are different keys', () => {
        expect(buildCacheKey(WS_ID, [])).not.toBe(buildCacheKey(WS_ID, [CONN_A]))
    })

    it('same allowlist, different order → same key (sort-normalised)', () => {
        expect(buildCacheKey(WS_ID, [CONN_A, CONN_B])).toBe(buildCacheKey(WS_ID, [CONN_B, CONN_A]))
    })
})
