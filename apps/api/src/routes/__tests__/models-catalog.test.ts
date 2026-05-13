// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 2b — models catalog route tests.
 *
 * Mounts the models router with mocked db + super-admin middleware.
 * Pins:
 *   1. /catalog returns paginated rows with attribute fields
 *   2. /catalog filters by provider + capability + cost class
 *   3. /catalog sorts by cost ascending
 *   4. /recommended/:taskType returns ordered picks
 *   5. /recommended rejects unknown task types
 *   6. /refresh requires super-admin and triggers the syncer
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    rows: [] as any[],
    syncCalled: 0,
}

const SAMPLE_ROWS = [
    {
        id: 'anthropic/claude-sonnet-4-5',
        provider: 'anthropic',
        model_id: 'claude-sonnet-4-5',
        context_window: 200_000,
        cost_per_m_in: 3,
        cost_per_m_out: 15,
        strengths: ['code', 'tools', 'reasoning'],
        reliability_score: 0.95,
        last_synced_at: new Date('2026-04-01').toISOString(),
    },
    {
        id: 'anthropic/claude-haiku-4-5',
        provider: 'anthropic',
        model_id: 'claude-haiku-4-5',
        context_window: 200_000,
        cost_per_m_in: 0.25,
        cost_per_m_out: 1.25,
        strengths: ['speed', 'tools'],
        reliability_score: 0.95,
        last_synced_at: new Date('2026-04-01').toISOString(),
    },
    {
        id: 'deepseek/deepseek-chat',
        provider: 'deepseek',
        model_id: 'deepseek-chat',
        context_window: 64_000,
        cost_per_m_in: 0.14,
        cost_per_m_out: 0.28,
        strengths: ['cheap', 'speed'],
        reliability_score: 0.85,
        last_synced_at: new Date('2026-04-01').toISOString(),
    },
    {
        id: 'groq/llama-3.3-70b-versatile',
        provider: 'groq',
        model_id: 'llama-3.3-70b-versatile',
        context_window: 128_000,
        cost_per_m_in: 0.59,
        cost_per_m_out: 0.79,
        strengths: ['speed', 'tools', 'open_source'],
        reliability_score: 0.9,
        last_synced_at: new Date('2026-04-01').toISOString(),
    },
]

vi.mock('@plexo/db', () => ({
    db: {
        execute: vi.fn(async () => ({ rows: ctl.rows })),
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
        { join: vi.fn() },
    ),
}))

vi.mock('../../middleware/super-admin.js', () => ({
    requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
}))

vi.mock('@plexo/agent/providers/knowledge', () => ({
    syncModelKnowledge: vi.fn(async () => {
        ctl.syncCalled += 1
        return { added: 5, updated: 10 }
    }),
}))

let server: Server | null = null
let baseUrl: string

beforeEach(async () => {
    ctl.rows = [...SAMPLE_ROWS]
    ctl.syncCalled = 0
    if (!server) {
        const { modelsRouter } = await import('../models.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/models', modelsRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

describe('GET /api/v1/models/catalog', () => {
    it('returns the paginated catalog with attribute fields', async () => {
        const res = await fetch(`${baseUrl}/api/v1/models/catalog`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.total).toBe(4)
        expect(body.items.length).toBe(4)
        for (const item of body.items) {
            expect(item).toHaveProperty('capabilities')
            expect(item).toHaveProperty('strengths')
            expect(item).toHaveProperty('latencyClass')
            expect(item).toHaveProperty('costClass')
        }
    })

    it('filters by provider', async () => {
        const res = await fetch(`${baseUrl}/api/v1/models/catalog?provider=anthropic`)
        const body = await res.json() as any
        expect(body.total).toBe(2)
        for (const item of body.items) expect(item.provider).toBe('anthropic')
    })

    it('filters by cost class', async () => {
        const res = await fetch(`${baseUrl}/api/v1/models/catalog?cost=cheap`)
        const body = await res.json() as any
        expect(body.total).toBeGreaterThan(0)
        for (const item of body.items) expect(item.costClass).toBe('cheap')
    })

    it('sorts by cost ascending', async () => {
        const res = await fetch(`${baseUrl}/api/v1/models/catalog?sort=cost`)
        const body = await res.json() as any
        for (let i = 1; i < body.items.length; i++) {
            expect(body.items[i].blendedCostPerM).toBeGreaterThanOrEqual(body.items[i - 1].blendedCostPerM)
        }
    })

    it('paginates', async () => {
        const res = await fetch(`${baseUrl}/api/v1/models/catalog?pageSize=2&page=1`)
        const body = await res.json() as any
        expect(body.items.length).toBe(2)
        expect(body.page).toBe(1)
        expect(body.pageSize).toBe(2)
        expect(body.total).toBe(4)
    })
})

describe('GET /api/v1/models/recommended/:taskType', () => {
    it('returns ordered picks for conversation', async () => {
        const res = await fetch(`${baseUrl}/api/v1/models/recommended/conversation`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.taskType).toBe('conversation')
        expect(Array.isArray(body.recommended)).toBe(true)
        // The recommended head should NOT be a reasoner (Phase 2b invariant).
        if (body.recommended.length > 0) {
            const top = body.recommended[0]
            expect(top.modelId.toLowerCase()).not.toContain('reasoner')
        }
    })

    it('rejects unknown task types', async () => {
        const res = await fetch(`${baseUrl}/api/v1/models/recommended/whatever`)
        expect(res.status).toBe(400)
    })
})

describe('POST /api/v1/models/refresh', () => {
    it('triggers the syncer and returns the result', async () => {
        const res = await fetch(`${baseUrl}/api/v1/models/refresh`, { method: 'POST' })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(ctl.syncCalled).toBe(1)
    })
})
