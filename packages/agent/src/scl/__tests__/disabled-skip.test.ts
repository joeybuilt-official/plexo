// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3a — SCL disabled-skip tests.
 *
 * Mocks @plexo/db so we can drive `loadSclRuntimeSettings` + `isSclEnabled`
 * deterministically. Pins:
 *   1. defaults when no row exists
 *   2. reads `intelligence_settings.scl.enabled` when set
 *   3. legacy `settings.scl_enabled` boolean still wins when new home empty
 *   4. cache hit on second call within TTL
 *   5. invalidate forces a reload
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ctl = {
    rows: [] as any[],
    selectCalls: 0,
}

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => {
            ctl.selectCalls += 1
            return ctl.rows
        }),
    }
    return {
        db: {
            select: vi.fn(() => builder),
            execute: vi.fn(async () => ({ rows: [] })),
        },
        workspaces: { id: 'id', settings: 'settings', intelligenceSettings: 'intelligence_settings' },
        workspaceMindsets: {},
        eq: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

beforeEach(async () => {
    ctl.rows = []
    ctl.selectCalls = 0
    const mod = await import('../storage.js')
    mod.invalidateAllSclRuntimeSettings()
})

describe('loadSclRuntimeSettings', () => {
    it('returns defaults when the workspace row is empty', async () => {
        ctl.rows = []
        const { loadSclRuntimeSettings, SCL_RUNTIME_DEFAULTS } = await import('../storage.js')
        const out = await loadSclRuntimeSettings('ws-empty')
        expect(out).toEqual(SCL_RUNTIME_DEFAULTS)
    })

    it('reads intelligence_settings.scl.enabled when present', async () => {
        ctl.rows = [{
            settings: { scl_enabled: false },
            intelligenceSettings: { scl: { enabled: true, driftThreshold: 0.3 } },
        }]
        const { loadSclRuntimeSettings } = await import('../storage.js')
        const out = await loadSclRuntimeSettings('ws-1')
        expect(out.enabled).toBe(true)
        expect(out.driftThreshold).toBeCloseTo(0.3)
    })

    it('falls back to legacy settings.scl_enabled when intelligence_settings.scl is empty', async () => {
        ctl.rows = [{
            settings: { scl_enabled: true },
            intelligenceSettings: {},
        }]
        const { loadSclRuntimeSettings } = await import('../storage.js')
        const out = await loadSclRuntimeSettings('ws-legacy')
        expect(out.enabled).toBe(true)
    })
})

describe('isSclEnabled', () => {
    it('returns default (true) when no settings exist', async () => {
        ctl.rows = []
        const { isSclEnabled } = await import('../storage.js')
        const enabled = await isSclEnabled('ws-empty')
        expect(enabled).toBe(true)
    })

    it('returns true when intelligence_settings.scl.enabled = true', async () => {
        ctl.rows = [{ settings: {}, intelligenceSettings: { scl: { enabled: true } } }]
        const { isSclEnabled } = await import('../storage.js')
        expect(await isSclEnabled('ws-1')).toBe(true)
    })

    it('caches the result for subsequent calls', async () => {
        ctl.rows = [{ settings: {}, intelligenceSettings: { scl: { enabled: true } } }]
        const { isSclEnabled } = await import('../storage.js')
        await isSclEnabled('ws-cache')
        await isSclEnabled('ws-cache')
        await isSclEnabled('ws-cache')
        expect(ctl.selectCalls).toBe(1)
    })

    it('reloads after invalidate', async () => {
        ctl.rows = [{ settings: {}, intelligenceSettings: { scl: { enabled: false } } }]
        const { isSclEnabled, invalidateSclRuntimeSettings } = await import('../storage.js')
        expect(await isSclEnabled('ws-bust')).toBe(false)
        ctl.rows = [{ settings: {}, intelligenceSettings: { scl: { enabled: true } } }]
        invalidateSclRuntimeSettings('ws-bust')
        expect(await isSclEnabled('ws-bust')).toBe(true)
        expect(ctl.selectCalls).toBe(2)
    })
})
