// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0001 §4 (4d) — registerTools session contract: mid-call reconnect +
 * idempotent-only replay. Covers the pure replay policy and the bridge wiring
 * (worker dies mid-call → toolset re-registered via getWorker; safe calls replay,
 * side-effecting calls fail-loud).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Pure policy ───────────────────────────────────────────────────────────────
import { canReplayOnReconnect } from '../bridge.js'

describe('canReplayOnReconnect', () => {
    it('replays idempotent tools', () => {
        expect(canReplayOnReconnect({ idempotent: true })).toBe(true)
    })
    it('replays explicitly-no-side-effect tools', () => {
        expect(canReplayOnReconnect({ hasSideEffects: false })).toBe(true)
    })
    it('does NOT replay side-effecting tools', () => {
        expect(canReplayOnReconnect({ hasSideEffects: true })).toBe(false)
    })
    it('does NOT replay when hints are absent/ambiguous (fail-loud default)', () => {
        expect(canReplayOnReconnect(undefined)).toBe(false)
        expect(canReplayOnReconnect({})).toBe(false)
        expect(canReplayOnReconnect({ timeoutMs: 5000 })).toBe(false)
    })
})

// ── Bridge reconnect wiring ───────────────────────────────────────────────────

type IR = { ok: boolean; result?: unknown; error?: string; timedOut?: boolean; durationMs: number }

const h = vi.hoisted(() => {
    const handle = {
        worker: {}, pluginName: '@acme/x', workspaceId: 'ws', activatedAt: 0,
        registeredTools: [{ name: 'do_thing', description: 'd', parameters: { type: 'object', properties: {} }, hints: {} as Record<string, unknown> }],
    }
    return {
        handle,
        workerLive: true,
        getWorker: vi.fn(async () => handle),
        invokeTool: vi.fn(async (): Promise<{ ok: boolean; result?: unknown; error?: string; timedOut?: boolean; durationMs: number }> => ({ ok: true, result: 'OK', durationMs: 1 })),
        isWorkerLive: vi.fn(() => h.workerLive),
    }
})

vi.mock('../persistent-pool.js', () => ({
    getWorker: h.getWorker,
    invokeTool: h.invokeTool,
    isWorkerLive: h.isWorkerLive,
}))

vi.mock('@plexo/db', () => {
    const wsChain = { where: () => ({ limit: async () => [{ settings: {}, ownerId: 'u1' }] }) }
    const extChain = { where: () => Promise.resolve([{
        name: '@acme/x', version: '1.0.0', entry: '/abs/entry.js', source: 'js', enabled: true,
        settings: {}, manifest: { type: 'tool', displayName: 'X', capabilities: [] },
    }]) }
    return {
        db: { select: (proj?: Record<string, unknown>) => ({ from: () => (proj && 'settings' in proj || proj && 'ownerId' in proj ? wsChain : extChain) }) },
        eq: vi.fn(() => ({})),
        and: vi.fn((...a: unknown[]) => ({ __and: a })),
        extensions: { _t: 'ext' },
        workspaces: { _t: 'ws' },
    }
})

import { loadPluginTools } from '../bridge.js'

const KEY = 'plugin__acme_x__do_thing'

beforeEach(() => {
    h.workerLive = true
    h.handle.registeredTools[0]!.hints = {}
    h.getWorker.mockClear()
    h.invokeTool.mockClear()
    h.invokeTool.mockResolvedValue({ ok: true, result: 'OK', durationMs: 1 })
})

async function getTool(hints: Record<string, unknown>) {
    h.handle.registeredTools[0]!.hints = hints
    const set = await loadPluginTools('ws')
    return set[KEY] as { execute: (a: unknown) => Promise<unknown> }
}

describe('loadPluginTools — mid-call reconnect', () => {
    it('live worker: invokes once, returns result', async () => {
        const tool = await getTool({})
        const loadCalls = h.getWorker.mock.calls.length
        const r = await tool.execute({})
        expect(r).toBe('OK')
        // one extra getWorker (re-acquire at call start) + one invoke
        expect(h.getWorker.mock.calls.length).toBe(loadCalls + 1)
        expect(h.invokeTool).toHaveBeenCalledTimes(1)
    })

    it('worker dies mid-call + idempotent → re-registers and replays', async () => {
        const tool = await getTool({ idempotent: true })
        h.invokeTool.mockReset()
        h.invokeTool
            .mockResolvedValueOnce({ ok: false, error: 'Worker crashed: boom', durationMs: 1 })
            .mockResolvedValueOnce({ ok: true, result: 'REPLAYED', durationMs: 2 })
        h.workerLive = false
        const r = await tool.execute({})
        expect(r).toBe('REPLAYED')
        expect(h.invokeTool).toHaveBeenCalledTimes(2) // original + replay
    })

    it('worker dies mid-call + side-effecting → fail-loud, no replay', async () => {
        const tool = await getTool({ hasSideEffects: true })
        h.invokeTool.mockReset()
        h.invokeTool.mockResolvedValueOnce({ ok: false, error: 'Worker crashed: boom', durationMs: 1 })
        h.workerLive = false
        const r = await tool.execute({}) as { status?: string; error?: string }
        expect(h.invokeTool).toHaveBeenCalledTimes(1) // NOT replayed
        expect(JSON.stringify(r)).toMatch(/restarted/i)
    })
})
