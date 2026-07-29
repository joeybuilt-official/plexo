// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2b — chain-resolver tests.
 *
 * Mocks `@plexo/db` so the resolver can be exercised without a real
 * Postgres instance. Pins:
 *   1. cache hit on second call inside the TTL
 *   2. cache miss after invalidate
 *   3. null return when no chain is configured
 *   4. ordered walk by `position`
 *   5. ChainTaskType keying
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ctl = {
    rows: [] as any[],
    executeCalls: 0,
}

vi.mock('@plexo/db', () => {
    return {
        db: {
            execute: vi.fn(async () => {
                ctl.executeCalls += 1
                return { rows: ctl.rows }
            }),
        },
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

beforeEach(async () => {
    ctl.rows = []
    ctl.executeCalls = 0
    const mod = await import('../chain-resolver.js')
    mod.invalidateAllChainResolver()
})

describe('resolveChain', () => {
    it('returns null when no rows for the workspace', async () => {
        ctl.rows = []
        const { resolveChain } = await import('../chain-resolver.js')
        const out = await resolveChain('ws-empty', 'conversation')
        expect(out).toBeNull()
    })

    it('returns ordered chain entries for the requested task type', async () => {
        ctl.rows = [
            { id: 'r1', task_type: 'conversation', provider_id: 'p1', model_id: 'claude-haiku-4-5', provider_type: 'anthropic', position: 0 },
            { id: 'r2', task_type: 'conversation', provider_id: 'p2', model_id: 'deepseek-chat', provider_type: 'deepseek', position: 1 },
            { id: 'r3', task_type: 'planning', provider_id: 'p1', model_id: 'claude-sonnet-4-5', provider_type: 'anthropic', position: 0 },
        ]
        const { resolveChain } = await import('../chain-resolver.js')
        const conv = await resolveChain('ws-1', 'conversation')
        expect(conv).not.toBeNull()
        expect(conv!).toHaveLength(2)
        expect(conv![0]!.modelId).toBe('claude-haiku-4-5')
        expect(conv![1]!.modelId).toBe('deepseek-chat')
        expect(conv![0]!.providerType).toBe('anthropic')
    })

    it('caches the workspace chain for follow-up lookups', async () => {
        ctl.rows = [
            { id: 'r1', task_type: 'conversation', provider_id: 'p1', model_id: 'm1', provider_type: 'anthropic', position: 0 },
        ]
        const { resolveChain } = await import('../chain-resolver.js')
        await resolveChain('ws-cache', 'conversation')
        await resolveChain('ws-cache', 'conversation')
        await resolveChain('ws-cache', 'planning')
        expect(ctl.executeCalls).toBe(1)
    })

    it('reloads after invalidate', async () => {
        ctl.rows = [
            { id: 'r1', task_type: 'conversation', provider_id: 'p1', model_id: 'm1', provider_type: 'anthropic', position: 0 },
        ]
        const { resolveChain, invalidateChainResolver } = await import('../chain-resolver.js')
        await resolveChain('ws-bust', 'conversation')
        expect(ctl.executeCalls).toBe(1)
        invalidateChainResolver('ws-bust')
        await resolveChain('ws-bust', 'conversation')
        expect(ctl.executeCalls).toBe(2)
    })

    it('returns null for a task type the workspace has no chain rows for', async () => {
        ctl.rows = [
            { id: 'r1', task_type: 'planning', provider_id: 'p1', model_id: 'm1', provider_type: 'anthropic', position: 0 },
        ]
        const { resolveChain } = await import('../chain-resolver.js')
        const out = await resolveChain('ws-mixed', 'codeGeneration')
        expect(out).toBeNull()
    })

    it('soft-fails to null on db errors', async () => {
        const { db } = await import('@plexo/db')
        ;(db.execute as any).mockRejectedValueOnce(new Error('boom'))
        const { resolveChain, invalidateAllChainResolver } = await import('../chain-resolver.js')
        invalidateAllChainResolver()
        const out = await resolveChain('ws-err', 'conversation')
        expect(out).toBeNull()
    })
})
