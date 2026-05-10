// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Test the Phase 5 cross-app auto-promotion wiring inside the nightly
 * synthesis cron. Other steps (cluster, suggestion gen, SCL eval) are
 * mocked — we only verify that when SYNTHESIS_AUTO_PROMOTE is on, the
 * promote module is invoked and its counts roll up into totals; and
 * when it is off, the module is NOT invoked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@plexo/db', () => ({
    db: { execute: vi.fn(async (q: unknown) => {
        // First call (workspace listing) → one workspace; subsequent → empty
        const s = String((q as { strings?: string[] })?.strings?.join?.(' ') ?? '')
        if (s.includes('FROM workspaces')) return [{ id: 'w-1' }]
        return []
    }) },
    sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, values: vals }),
}))

vi.mock('@plexo/agent/memory/cluster', () => ({
    clusterMemory: vi.fn(async () => ({
        clusters: [], noise: [], summary: [{ level: 1, count: 0 }],
        umap: {}, durationMs: 1, algoVersion: 'test',
    })),
}))

vi.mock('@plexo/agent/memory/suggest', () => ({
    generateThemeSuggestions: vi.fn(async () => ({ inserted: 0, skipped: 0, inspected: 0 })),
    generateLinkSuggestions: vi.fn(async () => ({ inserted: 0, skipped: 0, inspectedPairs: 0 })),
}))

vi.mock('@plexo/agent/memory/scl', () => ({
    evaluateSclPromotion: vi.fn(async () => ({ newlyPromoted: [], newlyDemoted: [] })),
    snapshotThemeHistory: vi.fn(async () => 0),
}))

vi.mock('@plexo/agent/memory/store', () => ({
    storeMemory: vi.fn(async () => null),
    embed: vi.fn(async () => null),
}))

vi.mock('@plexo/agent/providers/settings-from-instances', () => ({
    loadSettingsFromInstances: vi.fn(async () => null),
}))

vi.mock('@plexo/agent/memory/promote', () => ({
    autoPromoteAboveThreshold: vi.fn(async (opts: { workspaceId: string; confidenceThreshold?: number }) => ({
        workspaceId: opts.workspaceId,
        inspected: 3,
        promoted: 2,
        noRoute: 1,
        skipped: 0,
    })),
}))

import { runSynthesisNightly } from '../synthesis-nightly.js'
import { autoPromoteAboveThreshold } from '@plexo/agent/memory/promote'

const promoteMock = vi.mocked(autoPromoteAboveThreshold)

beforeEach(() => {
    promoteMock.mockClear()
    delete process.env.SYNTHESIS_AUTO_PROMOTE
})

afterEach(() => {
    delete process.env.SYNTHESIS_AUTO_PROMOTE
    delete process.env.SYNTHESIS_AUTO_PROMOTE_THRESHOLD
})

describe('synthesis-nightly Phase 5 wiring', () => {
    it('rolls cross-app promotion counts into totals when enabled (default)', async () => {
        const result = await runSynthesisNightly()
        expect(result.workspaces).toBe(1)
        expect(promoteMock).toHaveBeenCalledTimes(1)
        expect(result.totals.crossAppPromoted).toBe(2)
        expect(result.totals.crossAppNoRoute).toBe(1)
    })

    it('skips auto-promotion when SYNTHESIS_AUTO_PROMOTE=0', async () => {
        process.env.SYNTHESIS_AUTO_PROMOTE = '0'
        await runSynthesisNightly()
        expect(promoteMock).not.toHaveBeenCalled()
    })

    it('honours SYNTHESIS_AUTO_PROMOTE_THRESHOLD override', async () => {
        process.env.SYNTHESIS_AUTO_PROMOTE_THRESHOLD = '2.5'
        await runSynthesisNightly()
        const args = promoteMock.mock.calls[0]?.[0]
        expect(args?.confidenceThreshold).toBe(2.5)
    })
})
