// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2a — intelligence route handler tests.
 *
 * Mounts the intelligence router on a tiny express instance and drives
 * it via fetch. All external I/O (db reads + writes, intelligence-cache,
 * intelligence-spend, cost-enforcement) is stubbed via vi.mock so the
 * suite is fully hermetic.
 *
 * What we're checking:
 *   1. GET settings returns the resolved settings + ceiling decision
 *   2. PATCH inference-mode validates the mode + invalidates the cache
 *   3. PATCH cost-ceiling validates the ceiling + writes the JSONB
 *   4. PATCH cost-ceiling rejects bad input
 *   5. GET spend returns the snapshot + decision
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    invalidatedSettings: [] as string[],
    invalidatedSpend: [] as string[],
    cleared: [] as string[],
    executedSql: [] as any[],
    settingsRow: { s: { inferenceMode: 'auto', costCeilingUsd: 100, costCeilingMode: 'soft_warn' } } as any,
    spend: {
        workspaceId: 'ws-1',
        monthStart: '2026-04-01T00:00:00.000Z',
        pricedUsd: 12.5,
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        requests: 42,
        unpricedInputTokens: 0,
        unpricedOutputTokens: 0,
        computedAt: new Date().toISOString(),
    },
    decision: {
        state: 'ok' as 'ok' | 'warn' | 'block',
        usagePct: 0.125,
        ceilingUsd: 100 as number | null,
    },
}

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => [ctl.settingsRow]),
    }
    return {
        db: {
            select: vi.fn(() => builder),
            execute: vi.fn(async (q: any) => {
                ctl.executedSql.push(q)
                return undefined
            }),
        },
        workspaces: { intelligenceSettings: 'intelligence_settings' },
        eq: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('../../lib/intelligence-cache.js', () => ({
    invalidateIntelligenceSettings: vi.fn((id: string) => { ctl.invalidatedSettings.push(id) }),
}))

vi.mock('../../lib/intelligence-spend.js', () => ({
    getWorkspaceSpend: vi.fn(async () => ctl.spend),
    invalidateWorkspaceSpend: vi.fn((id: string) => { ctl.invalidatedSpend.push(id) }),
}))

vi.mock('../../middleware/cost-enforcement.js', () => ({
    evaluateCostCeiling: vi.fn(async () => ({
        state: ctl.decision.state,
        usagePct: ctl.decision.usagePct,
        ceilingUsd: ctl.decision.ceilingUsd,
        spend: ctl.spend,
        reason: 'soft_warn_80',
    })),
    clearWarnedWorkspace: vi.fn((id: string) => { ctl.cleared.push(id) }),
}))

vi.mock('../../middleware/workspace-access.js', () => ({
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

let server: Server | null = null
let baseUrl: string

beforeEach(async () => {
    ctl.invalidatedSettings = []
    ctl.invalidatedSpend = []
    ctl.cleared = []
    ctl.executedSql = []

    if (!server) {
        const { intelligenceRouter } = await import('../intelligence.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/intelligence', intelligenceRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => {
    if (server) server.close()
})

describe('GET /api/v1/intelligence/:workspaceId/settings', () => {
    it('returns the resolved settings + ceiling decision', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/settings`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.settings.inferenceMode).toBe('auto')
        expect(body.settings.costCeilingUsd).toBe(100)
        expect(body.settings.costCeilingMode).toBe('soft_warn')
        expect(body.ceiling.state).toBe('ok')
        expect(body.ceiling.ceilingUsd).toBe(100)
    })

    it('falls back to defaults when settings are empty', async () => {
        ctl.settingsRow = { s: {} }
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/settings`)
        const body = await res.json() as any
        expect(body.settings.inferenceMode).toBe('auto')
        expect(body.settings.costCeilingUsd).toBeNull()
        expect(body.settings.costCeilingMode).toBe('soft_warn')
    })
})

describe('PATCH /api/v1/intelligence/:workspaceId/settings/inference-mode', () => {
    it('accepts a valid mode and invalidates the cache', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/settings/inference-mode`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'override' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.inferenceMode).toBe('override')
        expect(ctl.invalidatedSettings).toContain('ws-1')
        expect(ctl.executedSql.length).toBeGreaterThan(0)
    })

    it('rejects an unknown mode', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/settings/inference-mode`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'whatever' }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects a missing mode', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/settings/inference-mode`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
    })
})

describe('PATCH /api/v1/intelligence/:workspaceId/settings/cost-ceiling', () => {
    it('writes the new ceiling and clears spend + warn caches', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/settings/cost-ceiling`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ceilingUsd: 250, mode: 'hard_block' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.ceilingUsd).toBe(250)
        expect(body.mode).toBe('hard_block')
        expect(ctl.invalidatedSettings).toContain('ws-1')
        expect(ctl.invalidatedSpend).toContain('ws-1')
        expect(ctl.cleared).toContain('ws-1')
    })

    it('accepts null to clear the ceiling', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/settings/cost-ceiling`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ceilingUsd: null }),
        })
        expect(res.status).toBe(200)
    })

    it('rejects negative ceilings', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/settings/cost-ceiling`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ceilingUsd: -10 }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects unknown enforcement mode', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/settings/cost-ceiling`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ceilingUsd: 50, mode: 'panic' }),
        })
        expect(res.status).toBe(400)
    })
})

describe('GET /api/v1/intelligence/:workspaceId/spend', () => {
    it('returns the spend snapshot and ceiling decision', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intelligence/ws-1/spend`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.spend.pricedUsd).toBeCloseTo(12.5)
        expect(body.spend.requests).toBe(42)
        expect(body.ceiling.state).toBe('ok')
    })
})
