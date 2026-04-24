// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3a — SCL settings route tests.
 *
 * Mounts the existing scl router (from routes/scl.ts) on a tiny express
 * instance and exercises the new GET/PATCH /settings, /domain-regions,
 * /pii-preview endpoints with all DB + cache + middleware mocks in place.
 *
 * Pins:
 *   1. GET /settings returns merged defaults + bounds
 *   2. GET /settings honors legacy `settings.scl_enabled` fallback
 *   3. PATCH /settings validates bounds + writes jsonb_set + invalidates caches
 *   4. PATCH /settings rejects unknown bodies
 *   5. /domain-regions returns ordered region rows
 *   6. /pii-preview returns scrubbed sample
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    settingsRow: {
        settings: {} as Record<string, unknown>,
        intelligenceSettings: {} as Record<string, unknown>,
    },
    domainRows: [] as any[],
    piiRows: [] as any[],
    executedSql: [] as any[],
    invalidatedSettings: [] as string[],
    invalidatedAgentSCL: [] as string[],
}

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => [ctl.settingsRow]),
        orderBy: vi.fn(() => builder),
    }
    return {
        db: {
            select: vi.fn(() => builder),
            execute: vi.fn(async (q: any) => {
                ctl.executedSql.push(q)
                const rendered = (q?.strings ?? []).join(' ')
                if (rendered.includes('FROM scl_concept_graphs')) return { rows: ctl.domainRows }
                if (rendered.includes('FROM inference_logs')) return { rows: ctl.piiRows }
                return { rows: [] }
            }),
            update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
        },
        workspaces: { id: 'id', settings: 'settings', intelligenceSettings: 'intelligence_settings' },
        sclDriftWarnings: {},
        eq: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../lib/intelligence-cache.js', () => ({
    invalidateIntelligenceSettings: vi.fn((id: string) => { ctl.invalidatedSettings.push(id) }),
}))

vi.mock('@plexo/agent/scl/storage', () => ({
    invalidateSclRuntimeSettings: vi.fn((id: string) => { ctl.invalidatedAgentSCL.push(id) }),
}))

vi.mock('@plexo/agent/scl/pii-scrub', () => ({
    scrubPII: vi.fn((s: string) => s
        .replace(/\S+@\S+/g, '[EMAIL]')
        .replace(/\d{3}-\d{2}-\d{4}/g, '[ID]')
        .replace(/\d{4}\s\d{4}\s\d{4}\s\d{4}/g, '[CARD]')
        .replace(/\$\d[\d,.]*/g, '[AMOUNT]')
    ),
}))

let server: Server | null = null
let baseUrl: string

beforeEach(async () => {
    ctl.settingsRow = { settings: {}, intelligenceSettings: {} }
    ctl.domainRows = []
    ctl.piiRows = []
    ctl.executedSql = []
    ctl.invalidatedSettings = []
    ctl.invalidatedAgentSCL = []
    if (!server) {
        const { sclRouter } = await import('../scl.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/scl', sclRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

const WS = 'ws-1'

describe('GET /api/v1/scl/settings', () => {
    it('returns defaults + bounds when intelligence_settings.scl is empty', async () => {
        const res = await fetch(`${baseUrl}/api/v1/scl/settings?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.settings.enabled).toBe(false)
        expect(body.settings.driftThreshold).toBeCloseTo(0.15)
        expect(body.settings.expandDepth).toBe(1)
        expect(body.settings.expandWidth).toBe(50)
        expect(body.settings.piiScrubEnabled).toBe(true)
        expect(body.bounds.driftThreshold).toEqual({ min: 0.05, max: 0.5 })
    })

    it('falls back to legacy settings.scl_enabled when new home is empty', async () => {
        ctl.settingsRow = {
            settings: { scl_enabled: true },
            intelligenceSettings: {},
        }
        const res = await fetch(`${baseUrl}/api/v1/scl/settings?workspaceId=${WS}`)
        const body = await res.json() as any
        expect(body.settings.enabled).toBe(true)
    })

    it('reads from intelligence_settings.scl when populated', async () => {
        ctl.settingsRow = {
            settings: { scl_enabled: false },
            intelligenceSettings: {
                scl: {
                    enabled: true,
                    driftThreshold: 0.25,
                    expandDepth: 2,
                    expandWidth: 100,
                    piiScrubEnabled: false,
                    domainRegions: ['code', 'product'],
                },
            },
        }
        const res = await fetch(`${baseUrl}/api/v1/scl/settings?workspaceId=${WS}`)
        const body = await res.json() as any
        expect(body.settings.enabled).toBe(true)
        expect(body.settings.driftThreshold).toBeCloseTo(0.25)
        expect(body.settings.expandDepth).toBe(2)
        expect(body.settings.expandWidth).toBe(100)
        expect(body.settings.piiScrubEnabled).toBe(false)
        expect(body.settings.domainRegions).toEqual(['code', 'product'])
    })
})

describe('PATCH /api/v1/scl/settings', () => {
    it('writes the merged scl block + busts caches', async () => {
        const res = await fetch(`${baseUrl}/api/v1/scl/settings`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceId: WS,
                enabled: true,
                driftThreshold: 0.2,
                expandDepth: 2,
            }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.settings.enabled).toBe(true)
        expect(body.settings.driftThreshold).toBeCloseTo(0.2)
        expect(body.settings.expandDepth).toBe(2)
        expect(ctl.invalidatedSettings).toContain(WS)
        expect(ctl.invalidatedAgentSCL).toContain(WS)
    })

    it('rejects out-of-bounds values', async () => {
        const res = await fetch(`${baseUrl}/api/v1/scl/settings`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, driftThreshold: 99 }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects empty patch bodies', async () => {
        const res = await fetch(`${baseUrl}/api/v1/scl/settings`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
    })

    it('accepts domainRegions arrays', async () => {
        const res = await fetch(`${baseUrl}/api/v1/scl/settings`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, domainRegions: ['code', 'ops'] }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.settings.domainRegions).toEqual(['code', 'ops'])
    })
})

describe('GET /api/v1/scl/domain-regions', () => {
    it('returns the workspace regions ordered by count', async () => {
        ctl.domainRows = [
            { domain_region: 'code', count: 12 },
            { domain_region: 'ops', count: 4 },
            { domain_region: 'product', count: 1 },
        ]
        const res = await fetch(`${baseUrl}/api/v1/scl/domain-regions?workspaceId=${WS}`)
        const body = await res.json() as any
        expect(body.regions).toHaveLength(3)
        expect(body.regions[0].region).toBe('code')
        expect(body.regions[0].count).toBe(12)
    })
})

describe('GET /api/v1/scl/pii-preview', () => {
    it('reports unavailable when no scrubbed logs exist', async () => {
        ctl.piiRows = []
        const res = await fetch(`${baseUrl}/api/v1/scl/pii-preview?workspaceId=${WS}`)
        const body = await res.json() as any
        expect(body.available).toBe(false)
    })

    it('returns the latest scrubbed log + a sample passthrough', async () => {
        ctl.piiRows = [
            {
                id: 'log-1',
                model: 'claude-haiku-4-5',
                scrub_input_pattern: '[EMAIL] [PHONE]',
                scrub_output_pattern: null,
                created_at: new Date('2026-04-01').toISOString(),
            },
        ]
        const res = await fetch(`${baseUrl}/api/v1/scl/pii-preview?workspaceId=${WS}`)
        const body = await res.json() as any
        expect(body.available).toBe(true)
        expect(body.latest.id).toBe('log-1')
        expect(body.sample.original).toContain('john.doe@example.com')
        expect(body.sample.scrubbed).toContain('[EMAIL]')
    })
})
