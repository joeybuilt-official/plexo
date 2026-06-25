// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 5 — intelligence dashboard route tests.
 *
 * Pins:
 *   1. GET /flow returns provider/chain/scl/memory/inferenceMode
 *   2. GET /logs returns priced rows
 *   3. GET /logs applies taskType/model filters
 *   4. GET /cost-summary returns spend + topModel + topTaskType
 *   5. GET /health probes return the expected service names
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    rows: {} as Record<string, any[]>,
    executedSql: [] as any[],
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

vi.mock('@plexo/db', () => ({
    db: {
        execute: vi.fn(async (q: any) => {
            ctl.executedSql.push(q)
            const rendered = renderSql(q)
            if (rendered.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] }
            if (rendered.includes('FROM provider_instances') && rendered.includes('ORDER BY preference_order')) {
                return { rows: ctl.rows.providers ?? [] }
            }
            if (rendered.includes('FROM routing_chains') && rendered.includes('GROUP BY task_type')) {
                return { rows: ctl.rows.chains ?? [] }
            }
            if (rendered.includes('FROM provider_instances') && rendered.includes('embedding_providers')) {
                return { rows: ctl.rows.embeddingCounts ?? [] }
            }
            if (rendered.includes('SELECT intelligence_settings')) {
                return { rows: ctl.rows.settings ?? [] }
            }
            if (rendered.includes('WITH priced AS')) {
                return { rows: ctl.rows.breakdown ?? [] }
            }
            if (rendered.includes('router_v2_stats')) {
                return { rows: ctl.rows.routerStats ?? [] }
            }
            if (rendered.includes('FROM inference_logs') && rendered.includes('LEFT JOIN models_knowledge')) {
                return { rows: ctl.rows.logs ?? [] }
            }
            if (rendered.includes('FROM inference_logs') && rendered.includes('INTERVAL')) {
                return { rows: [{ n: 0 }] }
            }
            if (rendered.includes('UPDATE workspaces') && rendered.includes('jsonb_set')) {
                ctl.rows.lastWizardComplete = [{ updated: true }]
                return { rows: [] }
            }
            return { rows: [] }
        }),
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
        { join: vi.fn() },
    ),
}))

// ADR-0045 Phase 2: source imports drizzle operators from 'drizzle-orm' now.
// Mirror whatever operator stubs the @plexo/db mock defines so the fake db
// still sees the same recognizable shapes (fall back to real drizzle otherwise).
vi.mock('drizzle-orm', async (importOriginal) => {
    const real = await importOriginal<Record<string, unknown>>()
    const m = (await import('@plexo/db')) as Record<string, unknown>
    const pick = (k: string): unknown => (k in m ? m[k] : real[k])
    return {
        ...real,
        eq: pick('eq'), and: pick('and'), or: pick('or'), ne: pick('ne'),
        desc: pick('desc'), asc: pick('asc'), inArray: pick('inArray'),
        isNull: pick('isNull'), isNotNull: pick('isNotNull'), ilike: pick('ilike'),
        lt: pick('lt'), lte: pick('lte'), gte: pick('gte'), count: pick('count'),
        sql: pick('sql'),
    }
})


vi.mock('../../middleware/workspace-access.js', () => ({
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../lib/intelligence-spend.js', () => ({
    getWorkspaceSpend: vi.fn(async () => ({
        workspaceId: 'ws-1',
        monthStart: '2026-04-01T00:00:00.000Z',
        pricedUsd: 12.5,
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        requests: 42,
        unpricedInputTokens: 0,
        unpricedOutputTokens: 0,
        computedAt: new Date().toISOString(),
    })),
    loadAppSpend: vi.fn(async () => [
        { appId: 'graphiti-sidecar', pricedUsd: 0.4, inputTokens: 200_000, outputTokens: 50_000, requests: 40 },
    ]),
}))

let server: Server | null = null
let baseUrl: string
const WS = '00000000-0000-0000-0000-000000000001'

beforeEach(async () => {
    ctl.rows = {}
    ctl.executedSql = []
    if (!server) {
        const { intelligenceDashboardRouter } = await import('../intelligence-dashboard.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/intel-dashboard', intelligenceDashboardRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>((resolve) => created.once('listening', () => resolve()))
        const addr = created.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(() => { if (server) server.close() })

describe('GET /api/v1/intel-dashboard/:ws/flow', () => {
    it('returns provider/chain/scl/memory/inferenceMode', async () => {
        ctl.rows.providers = [
            { id: 'p1', provider_type: 'anthropic', nickname: 'anthropic-1', enabled: true, managed: false, selected_model: 'claude-sonnet-4-5', embedding_model: null, embedding_dimensions: null },
            { id: 'p2', provider_type: 'deepseek', nickname: null, enabled: false, managed: false, selected_model: 'deepseek-chat', embedding_model: null, embedding_dimensions: null },
        ]
        ctl.rows.chains = [
            { task_type: 'conversation', length: 2 },
            { task_type: 'planning', length: 1 },
        ]
        ctl.rows.embeddingCounts = [{ embedding_providers: 1, total_providers: 2 }]
        ctl.rows.settings = [{ s: { inferenceMode: 'byok', scl: { enabled: true, driftThreshold: 0.2 }, memory: { eviction: { enabled: true } } } }]
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/flow`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.providers).toHaveLength(2)
        expect(body.chains).toHaveLength(2)
        expect(body.embeddings.configured).toBe(1)
        expect(body.scl.enabled).toBe(true)
        expect(body.memory.evictionEnabled).toBe(true)
        expect(body.inferenceMode).toBe('byok')
    })

    it('falls back to defaults for empty settings', async () => {
        ctl.rows.settings = [{ s: {} }]
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/flow`)
        const body = await res.json() as any
        expect(body.scl.enabled).toBe(false)
        expect(body.memory.evictionEnabled).toBe(false)
        expect(body.inferenceMode).toBe('auto')
    })
})

describe('GET /api/v1/intel-dashboard/:ws/logs', () => {
    it('prices rows via the models_knowledge join', async () => {
        ctl.rows.logs = [
            {
                id: 'log-1', model: 'claude-sonnet-4-5', provider: 'anthropic',
                task_type: 'codeGeneration', input_tokens: 1000, output_tokens: 500,
                latency_ms: 4200, success: true, created_at: new Date().toISOString(),
                cost_per_m_in: 3, cost_per_m_out: 15,
            },
            {
                id: 'log-2', model: 'unknown-model', provider: null,
                task_type: 'conversation', input_tokens: 10, output_tokens: 10,
                latency_ms: 120, success: true, created_at: new Date().toISOString(),
                cost_per_m_in: null, cost_per_m_out: null,
            },
        ]
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/logs`)
        const body = await res.json() as any
        expect(body.logs).toHaveLength(2)
        // 1000/1M * 3 + 500/1M * 15 = 0.003 + 0.0075 = 0.0105
        expect(body.logs[0].costUsd).toBeCloseTo(0.0105, 4)
        expect(body.logs[0].priced).toBe(true)
        expect(body.logs[1].costUsd).toBe(0)
        expect(body.logs[1].priced).toBe(false)
    })

    it('applies taskType and model filters (query string reaches SQL)', async () => {
        ctl.rows.logs = []
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/logs?taskType=conversation&model=claude-haiku-4-5`)
        expect(res.status).toBe(200)
        // Ensure the query params ended up somewhere in the executed SQL
        // values — the mock just needs to see the templated SQL include
        // the task_type + model clause markers.
        const rendered = ctl.executedSql.map(renderSql).join(' | ')
        expect(rendered).toContain('il.task_type =')
        expect(rendered).toContain('il.model =')
    })
})

describe('GET /api/v1/intel-dashboard/:ws/cost-summary', () => {
    it('returns spend plus top model and top task', async () => {
        ctl.rows.breakdown = [{
            top_model: 'claude-sonnet-4-5',
            top_model_cost: 9.5,
            top_model_requests: 30,
            top_task_type: 'codeGeneration',
            top_task_cost: 8.0,
            top_task_requests: 22,
        }]
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/cost-summary`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.spend.pricedUsd).toBeCloseTo(12.5)
        expect(body.topModel.model).toBe('claude-sonnet-4-5')
        expect(body.topModel.costUsd).toBeCloseTo(9.5)
        expect(body.topTaskType.taskType).toBe('codeGeneration')
        // Round-5 Phase 6: per-app attribution surfaced in the dashboard.
        expect(Array.isArray(body.appSpend)).toBe(true)
        expect(body.appSpend[0].appId).toBe('graphiti-sidecar')
    })

    it('handles empty breakdown gracefully', async () => {
        ctl.rows.breakdown = [{
            top_model: null, top_model_cost: null, top_model_requests: null,
            top_task_type: null, top_task_cost: null, top_task_requests: null,
        }]
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/cost-summary`)
        const body = await res.json() as any
        expect(body.topModel).toBeNull()
        expect(body.topTaskType).toBeNull()
    })
})

describe('GET /api/v1/intel-dashboard/:ws/router-stats (Round-5 Phase 9)', () => {
    it('returns the latest router_v2_stats bucket per key', async () => {
        ctl.rows.routerStats = [{
            provider: 'deepseek', model: 'deepseek-v4-flash', task_type: 'extraction',
            sample_count: 120, success_rate: 0.98,
            latency_p50_ms: 400, latency_p95_ms: 1200,
            cooldown_end_at: null, snapshot_at: '2026-06-06T21:00:00.000Z',
        }]
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/router-stats`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.count).toBe(1)
        expect(body.buckets[0]).toMatchObject({
            provider: 'deepseek', model: 'deepseek-v4-flash', taskType: 'extraction',
            sampleCount: 120, successRate: 0.98, latencyP50Ms: 400, latencyP95Ms: 1200,
        })
    })

    it('returns an empty list when no recent snapshots', async () => {
        ctl.rows.routerStats = []
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/router-stats`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.count).toBe(0)
        expect(body.buckets).toEqual([])
    })
})

describe('GET /api/v1/intel-dashboard/:ws/health', () => {
    it('returns a probe result for each expected service', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/health`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        const names = body.services.map((s: any) => s.name).sort()
        // postgres runs via db.execute mock (returns ok). redis/embeddings/
        // ollama may be unknown when env vars aren't set in the test process.
        expect(names).toContain('postgres')
        expect(names).toContain('embeddings')
        expect(names).toContain('ollama')
        expect(names).toContain('redis')
        expect(body.services.find((s: any) => s.name === 'postgres').status).toBe('up')
    })
})

// ── Phase 6 — first-run wizard endpoints ──────────────────────────────

describe('GET /api/v1/intel-dashboard/:ws/detect', () => {
    it('returns services + provider inventory + recommendations', async () => {
        ctl.rows.providers = [
            { id: 'p1', provider_type: 'anthropic', nickname: null, enabled: true, managed: false, embedding_model: null, selected_model: 'claude-sonnet-4-5' },
            { id: 'p2', provider_type: 'openai', nickname: 'oai', enabled: true, managed: false, embedding_model: 'text-embedding-3-small', selected_model: 'gpt-4o' },
            { id: 'p3', provider_type: 'deepseek', nickname: null, enabled: false, managed: false, embedding_model: null, selected_model: 'deepseek-chat' },
        ]
        ctl.rows.settings = [{ s: { firstRunPending: true } }]
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/detect`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.services.postgres.status).toBe('up')
        expect(body.services.pgvector.status).toBe('up')
        expect(body.providers.total).toBe(3)
        expect(body.providers.enabled).toBe(2)
        expect(body.providers.withChat).toBe(2)
        expect(body.providers.withEmbedding).toBe(1)
        expect(body.current.firstRunPending).toBe(true)
        expect(body.current.inferenceMode).toBe('auto')
        expect(body.recommendations.inferenceMode).toBe('auto')
        expect(body.recommendations.costCeilingUsd).toBe(20)
    })

    it('treats unset firstRunPending as still pending (true)', async () => {
        ctl.rows.providers = []
        ctl.rows.settings = [{ s: {} }]
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/detect`)
        const body = await res.json() as any
        // Default — workspace has never gone through the wizard, so the
        // banner should still appear. Only an explicit `false` flips it.
        expect(body.current.firstRunPending).toBe(true)
    })

    it('treats firstRunPending=false as resolved', async () => {
        ctl.rows.providers = []
        ctl.rows.settings = [{ s: { firstRunPending: false } }]
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/detect`)
        const body = await res.json() as any
        expect(body.current.firstRunPending).toBe(false)
    })
})

describe('POST /api/v1/intel-dashboard/:ws/wizard/complete', () => {
    it('flips firstRunPending via jsonb_set', async () => {
        const res = await fetch(`${baseUrl}/api/v1/intel-dashboard/${WS}/wizard/complete`, { method: 'POST' })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.firstRunPending).toBe(false)
        // The mock SQL log should have an UPDATE … jsonb_set entry.
        const rendered = ctl.executedSql.map(renderSql).join(' | ')
        expect(rendered).toContain('UPDATE workspaces')
        expect(rendered).toContain('jsonb_set')
        expect(rendered).toContain('firstRunPending')
    })
})
