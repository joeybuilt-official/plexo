// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub @plexo/db so the helper's UPDATE memory_entries / scl_concept_graphs
// statements become no-ops. The test exercises the loop logic, not the SQL.
vi.mock('@plexo/db', () => ({
    db: {
        execute: vi.fn(async () => undefined),
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ..._values: unknown[]) => ({ strings }),
        { join: vi.fn() },
    ),
}))

const {
    runReembedJob,
    _setReembedDeps,
    _resetReembedDeps,
    _resetReembedRegistry,
} = await import('../embeddings-reembed.js')

import type { EmbeddingAdapter } from '@plexo/agent/embeddings/router'
import type { ReembedJobReport } from '../embeddings-reembed.js'

// ── Stub adapter ───────────────────────────────────────────────────────────

function makeAdapter(opts: {
    providerId?: string
    model?: string
    dimensions?: number
    failOnIds?: string[]
} = {}): EmbeddingAdapter {
    const dims = opts.dimensions ?? 4
    return {
        providerId: opts.providerId ?? 'openai',
        model: opts.model ?? 'text-embedding-3-small',
        dimensions: dims,
        async embed(text: string): Promise<number[]> {
            if (opts.failOnIds && opts.failOnIds.some(id => text.includes(id))) {
                throw new Error('boom')
            }
            return new Array(dims).fill(0).map((_, i) => (text.length + i) / 10)
        },
    }
}

interface FakeRow {
    id: string
    content: string
    metadata: Record<string, unknown> | null
    created_at: Date
}

let memoryStore: FakeRow[] = []
let sclStore: Array<{ id: string; domain_region: string | null; graph_json: Record<string, unknown> | null }> = []
let persisted: { workspaceId: string; report: ReembedJobReport } | null = null

beforeEach(() => {
    _resetReembedDeps()
    _resetReembedRegistry()
    memoryStore = []
    sclStore = []
    persisted = null
    _setReembedDeps({
        memoryFetcher: async (_ws, since, limit) => {
            const filtered = since
                ? memoryStore.filter(r => r.created_at > since)
                : memoryStore
            return filtered
                .slice()
                .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
                .slice(0, limit) as any
        },
        sclFetcher: async () => sclStore as any,
        reportPersister: async (workspaceId, report) => {
            persisted = { workspaceId, report: { ...report } }
        },
    })
})

function row(id: string, ageSec: number, meta: Record<string, unknown> = {}): FakeRow {
    return {
        id,
        content: `content-${id}`,
        metadata: meta,
        created_at: new Date(Date.UTC(2026, 3, 10, 0, 0, ageSec)),
    }
}

describe('runReembedJob', () => {
    it('re-embeds rows that lack the target lineage and reports counts', async () => {
        memoryStore = [row('a', 1), row('b', 2), row('c', 3)]
        const adapter = makeAdapter({ providerId: 'openai', model: 'text-embedding-3-small', dimensions: 4 })

        const report = await runReembedJob('job-1', { workspaceId: 'ws-1', adapter, batchSize: 100 })

        expect(report.status).toBe('completed')
        expect(report.rowsScanned).toBe(3)
        expect(report.rowsReembedded).toBe(3)
        expect(report.rowsSkipped).toBe(0)
        expect(report.rowsErrored).toBe(0)
        expect(report.targetProvider).toBe('openai')
    })

    it('skips rows whose metadata already matches the target lineage (idempotent)', async () => {
        memoryStore = [
            row('a', 1, { embedding_provider: 'openai', embedding_model: 'text-embedding-3-small' }),
            row('b', 2, { embedding_provider: 'voyage', embedding_model: 'voyage-3' }),
            row('c', 3, { embedding_provider: 'openai', embedding_model: 'text-embedding-3-small' }),
        ]
        const adapter = makeAdapter({ providerId: 'openai', model: 'text-embedding-3-small' })

        const report = await runReembedJob('job-2', { workspaceId: 'ws-1', adapter })

        expect(report.rowsScanned).toBe(3)
        expect(report.rowsReembedded).toBe(1) // only the voyage row
        expect(report.rowsSkipped).toBe(2)
    })

    it('logs errored rows but keeps going (soft fail)', async () => {
        memoryStore = [row('good1', 1), row('bad-id', 2), row('good2', 3)]
        const adapter = makeAdapter({ failOnIds: ['bad-id'] })

        const report = await runReembedJob('job-3', { workspaceId: 'ws-1', adapter })

        expect(report.rowsScanned).toBe(3)
        expect(report.rowsReembedded).toBe(2)
        expect(report.rowsErrored).toBe(1)
        expect(report.status).toBe('completed')
    })

    it('iterates across batch boundaries until the store is drained', async () => {
        memoryStore = Array.from({ length: 7 }, (_, i) => row(`r${i}`, i + 1))
        const adapter = makeAdapter()

        const report = await runReembedJob('job-4', { workspaceId: 'ws-1', adapter, batchSize: 3 })

        expect(report.rowsScanned).toBe(7)
        expect(report.rowsReembedded).toBe(7)
    })

    it('resumes from a checkpoint when sinceCreatedAt is provided', async () => {
        memoryStore = [row('a', 1), row('b', 2), row('c', 3), row('d', 4)]
        const adapter = makeAdapter()

        const report = await runReembedJob('job-5', {
            workspaceId: 'ws-1',
            adapter,
            sinceCreatedAt: new Date(Date.UTC(2026, 3, 10, 0, 0, 2)).toISOString(),
        })

        // Only rows c and d are after the checkpoint
        expect(report.rowsScanned).toBe(2)
        expect(report.rowsReembedded).toBe(2)
    })

    it('also re-tags SCL graph_json when includeScl is true', async () => {
        memoryStore = [row('a', 1)]
        sclStore = [
            { id: 's1', domain_region: 'core', graph_json: {} },
            { id: 's2', domain_region: 'core', graph_json: { embedding_lineage: { provider: 'openai', model: 'text-embedding-3-small' } } },
        ]
        const adapter = makeAdapter({ providerId: 'openai', model: 'text-embedding-3-small' })

        const report = await runReembedJob('job-6', { workspaceId: 'ws-1', adapter, includeScl: true })

        expect(report.sclScanned).toBe(2)
        expect(report.sclReembedded).toBe(1)
        expect(report.sclSkipped).toBe(1)
    })

    it('persists the final report via the configured persister', async () => {
        memoryStore = [row('a', 1)]
        const adapter = makeAdapter()

        await runReembedJob('job-7', { workspaceId: 'ws-7', adapter })

        expect(persisted).not.toBeNull()
        expect(persisted!.workspaceId).toBe('ws-7')
        expect(persisted!.report.status).toBe('completed')
        expect(persisted!.report.rowsReembedded).toBe(1)
    })
})
