// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 4 — Memory UI route tests.
 *
 * Exercises the Phase 4 additions to the existing memory router:
 *   - GET /entries with namespace + tier + q (text path + semantic path)
 *   - PATCH /entries/:id/tier
 *   - GET /namespaces
 *   - GET /eviction + PATCH /eviction
 *
 * The legacy routes on the same router (POST /entries, PUT /entries/:id,
 * /preferences, etc.) are untouched by Phase 4 and are not re-tested
 * here — their existing coverage lives elsewhere.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    listRows: [] as any[],
    countRows: [] as any[],
    namespaceRows: [] as any[],
    updateRows: [] as any[],
    settingsRow: null as any,
    executedSql: [] as any[],
    semanticResults: [] as any[],
}

function renderSql(q: any): string {
    if (!q) return ''
    if (typeof q === 'string') return q
    if (Array.isArray(q?.strings)) {
        let out = ''
        for (let i = 0; i < q.strings.length; i++) {
            out += q.strings[i]
            if (i < q.values.length) out += ' ' + renderSql(q.values[i]) + ' '
        }
        return out
    }
    return ''
}

vi.mock('@plexo/db', () => {
    return {
        db: {
            execute: vi.fn(async (q: any) => {
                ctl.executedSql.push(q)
                const rendered = renderSql(q)
                if (rendered.includes('GROUP BY namespace')) return ctl.namespaceRows
                if (rendered.includes('UPDATE memory_entries')) return ctl.updateRows
                if (rendered.includes('count(*)::int as total')) return ctl.countRows
                if (rendered.includes('SELECT intelligence_settings')) {
                    return ctl.settingsRow ? [ctl.settingsRow] : [{}]
                }
                if (rendered.includes('UPDATE workspaces')) return []
                if (rendered.includes('FROM memory_entries')) return ctl.listRows
                return []
            }),
        },
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('@plexo/agent/memory/store', () => ({
    searchMemory: vi.fn(async () => ctl.semanticResults),
}))

vi.mock('@plexo/agent/memory/preferences', () => ({
    getPreferences: vi.fn(),
}))

vi.mock('@plexo/agent/memory/self-improvement', () => ({
    runSelfImprovementCycle: vi.fn(),
    getImprovementLog: vi.fn(),
}))

vi.mock('@plexo/agent/memory/prompt-improvement', () => ({
    proposePromptImprovements: vi.fn(),
    applyPromptPatch: vi.fn(),
}))

vi.mock('../ai-provider-creds.js', () => ({
    loadDecryptedAIProviders: vi.fn(),
}))

vi.mock('@plexo/storage', () => ({
    uploadToKey: vi.fn(),
}))

vi.mock('../../event-tracker.js', () => ({
    trackEvent: vi.fn(),
}))

vi.mock('../../lib/intelligence-cache.js', () => ({
    invalidateIntelligenceSettings: vi.fn(),
}))

let server: Server | null = null
let baseUrl: string
const WS = '00000000-0000-0000-0000-000000000000'

beforeEach(async () => {
    ctl.listRows = []
    ctl.countRows = [{ total: 0 }]
    ctl.namespaceRows = []
    ctl.updateRows = []
    ctl.settingsRow = null
    ctl.semanticResults = []
    ctl.executedSql = []
    if (!server) {
        const { memoryRouter } = await import('../memory.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/memory', memoryRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

describe('GET /api/v1/memory/entries', () => {
    it('returns SQL-path rows with total + list mode', async () => {
        ctl.listRows = [
            { id: 'm1', type: 'task', content: 'hello', shorthand: null, metadata: {}, tier: 'active', namespace: 'default', created_at: new Date().toISOString() },
            { id: 'm2', type: 'pattern', content: 'bye', shorthand: null, metadata: {}, tier: 'hot', namespace: 'default', created_at: new Date().toISOString() },
        ]
        ctl.countRows = [{ total: 2 }]
        const res = await fetch(`${baseUrl}/api/v1/memory/entries?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.items).toHaveLength(2)
        expect(body.total).toBe(2)
        expect(body.mode).toBe('list')
    })

    it('delegates to searchMemory when q is set + tier != cold', async () => {
        ctl.semanticResults = [
            { id: 'm3', type: 'task', content: 'deploy the api', shorthand: null, metadata: {}, tier: 'active', namespace: 'default', createdAt: new Date(), similarity: 0.82 },
        ]
        const res = await fetch(`${baseUrl}/api/v1/memory/entries?workspaceId=${WS}&q=deploy`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.mode).toBe('semantic')
        expect(body.items).toHaveLength(1)
        expect(body.items[0].similarity).toBeCloseTo(0.82)
    })

    it('keeps SQL path when tier=cold so users can dig out evicted entries', async () => {
        ctl.listRows = [
            { id: 'mc', type: 'task', content: 'old', shorthand: null, metadata: {}, tier: 'cold', namespace: 'default', created_at: new Date().toISOString() },
        ]
        ctl.countRows = [{ total: 1 }]
        const res = await fetch(`${baseUrl}/api/v1/memory/entries?workspaceId=${WS}&tier=cold&q=old`)
        const body = await res.json() as any
        expect(body.mode).toBe('text')
        expect(body.items[0].tier).toBe('cold')
    })

    it('rejects bad workspaceId', async () => {
        const res = await fetch(`${baseUrl}/api/v1/memory/entries?workspaceId=not-a-uuid`)
        expect(res.status).toBe(400)
    })
})

describe('PATCH /api/v1/memory/entries/:id/tier', () => {
    it('promotes a memory entry', async () => {
        ctl.updateRows = [{ id: '11111111-1111-1111-1111-111111111111' }]
        const res = await fetch(`${baseUrl}/api/v1/memory/entries/11111111-1111-1111-1111-111111111111/tier`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, tier: 'hot' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.tier).toBe('hot')
    })

    it('404s when the entry does not exist', async () => {
        ctl.updateRows = []
        const res = await fetch(`${baseUrl}/api/v1/memory/entries/22222222-2222-2222-2222-222222222222/tier`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, tier: 'cold' }),
        })
        expect(res.status).toBe(404)
    })

    it('rejects invalid tier values', async () => {
        const res = await fetch(`${baseUrl}/api/v1/memory/entries/11111111-1111-1111-1111-111111111111/tier`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, tier: 'lukewarm' }),
        })
        expect(res.status).toBe(400)
    })
})

describe('GET /api/v1/memory/namespaces', () => {
    it('returns per-namespace counts', async () => {
        ctl.namespaceRows = [
            { namespace: 'default', total: 10, hot: 2, active: 7, cold: 1 },
            { namespace: 'agent-sprint-runner', total: 4, hot: 0, active: 3, cold: 1 },
            { namespace: 'shared', total: 2, hot: 0, active: 2, cold: 0 },
        ]
        const res = await fetch(`${baseUrl}/api/v1/memory/namespaces?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.namespaces).toHaveLength(3)
        expect(body.namespaces[0].namespace).toBe('default')
        expect(body.namespaces[0].total).toBe(10)
        expect(body.namespaces[0].active).toBe(7)
    })
})

describe('GET /api/v1/memory/eviction', () => {
    it('returns defaults when the block is empty', async () => {
        ctl.settingsRow = { s: {} }
        const res = await fetch(`${baseUrl}/api/v1/memory/eviction?workspaceId=${WS}`)
        const body = await res.json() as any
        expect(body.eviction.enabled).toBe(false)
        expect(body.eviction.coldMaxAgeDays).toBe(90)
        expect(body.eviction.activeMaxAgeDays).toBe(30)
        expect(body.bounds.coldMaxAgeDays).toEqual({ min: 7, max: 3650 })
    })

    it('reads merged settings from intelligence_settings.memory.eviction', async () => {
        ctl.settingsRow = { s: { memory: { eviction: { enabled: true, coldMaxAgeDays: 45, activeMaxAgeDays: 10 } } } }
        const res = await fetch(`${baseUrl}/api/v1/memory/eviction?workspaceId=${WS}`)
        const body = await res.json() as any
        expect(body.eviction.enabled).toBe(true)
        expect(body.eviction.coldMaxAgeDays).toBe(45)
        expect(body.eviction.activeMaxAgeDays).toBe(10)
    })
})

describe('PATCH /api/v1/memory/eviction', () => {
    it('writes a merged patch + returns the merged view', async () => {
        ctl.settingsRow = { s: {} }
        const res = await fetch(`${baseUrl}/api/v1/memory/eviction`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, enabled: true, coldMaxAgeDays: 30 }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.eviction.enabled).toBe(true)
        expect(body.eviction.coldMaxAgeDays).toBe(30)
        expect(body.eviction.activeMaxAgeDays).toBe(30) // default
    })

    it('rejects out-of-bounds values', async () => {
        const res = await fetch(`${baseUrl}/api/v1/memory/eviction`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, coldMaxAgeDays: 99999 }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects an empty patch body', async () => {
        const res = await fetch(`${baseUrl}/api/v1/memory/eviction`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
    })
})
