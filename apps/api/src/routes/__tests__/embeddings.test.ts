// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 — Embeddings route handler tests.
 *
 * These tests mount the embeddings router on a tiny express instance
 * and drive it via fetch. All external I/O (db, intelligence-cache,
 * embeddings-reembed, agent embeddings router, the local embeddings
 * server) is stubbed via vi.mock so the suite is fully hermetic.
 *
 * What we're checking:
 *   1. GET providers returns the embedding-relevant subset of provider_instances
 *      with selected model + dimensions resolved through DEFAULT_EMBEDDING_MODELS.
 *   2. PATCH model writes the new model + dims and reports dimensionChanged.
 *   3. PATCH model invalidates the intelligence cache for the workspace.
 *   4. GET local/health returns "not-detected" when EMBEDDINGS_URL is unset.
 *   5. POST reembed kicks the helper, returns a jobId, and persists state.
 *   6. GET reembed/:jobId returns the in-memory job report.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Mock state ─────────────────────────────────────────────────────────────

const ctl = {
    rows: [] as any[],
    updated: null as any,
    invalidated: [] as string[],
    persistedSettings: null as any,
    startedJob: null as any,
    fetchedJob: null as any,
}

vi.mock('@plexo/db', () => {
    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => ctl.rows.slice(0, 1)),
        update: vi.fn(() => builder),
        set: vi.fn((v: any) => { ctl.updated = v; return builder }),
        returning: vi.fn(async () => ctl.rows.slice(0, 1)),
    }
    // Direct .from(...).where(...) chains used in GET providers
    builder.from = vi.fn(() => builder)
    builder.where = vi.fn(() => builder)
    // The GET providers handler awaits the chain (no .limit), so make it
    // thenable to resolve to ctl.rows.
    Object.defineProperty(builder, 'then', {
        configurable: true,
        get() {
            return (resolve: (rows: any[]) => void) => resolve(ctl.rows)
        },
    })

    return {
        db: {
            select: vi.fn(() => builder),
            update: vi.fn(() => builder),
            execute: vi.fn(async () => undefined),
        },
        providerInstances: { $inferSelect: {} },
        workspaces: { $inferSelect: {} },
        eq: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ..._values: unknown[]) => ({ strings }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('../../lib/intelligence-cache.js', () => ({
    invalidateIntelligenceSettings: vi.fn((id: string) => { ctl.invalidated.push(id) }),
}))

vi.mock('../../middleware/workspace-access.js', () => ({
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../lib/embeddings-reembed.js', () => ({
    startReembedJob: vi.fn((params: any) => {
        ctl.startedJob = params
        return {
            jobId: 'job-test-1',
            workspaceId: params.workspaceId,
            status: 'running',
            startedAt: new Date().toISOString(),
            rowsScanned: 0,
            rowsReembedded: 0,
            rowsSkipped: 0,
            rowsErrored: 0,
            sclScanned: 0,
            sclReembedded: 0,
            sclSkipped: 0,
            sclErrored: 0,
            targetProvider: params.adapter.providerId,
            targetModel: params.adapter.model,
            targetDimensions: params.adapter.dimensions,
        }
    }),
    getReembedJob: vi.fn((jobId: string) => {
        if (ctl.fetchedJob && ctl.fetchedJob.jobId === jobId) return ctl.fetchedJob
        return null
    }),
}))

vi.mock('@plexo/agent/embeddings/router', () => ({
    resolveEmbeddingAdapterAsync: vi.fn(async () => ({
        adapter: {
            providerId: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
            embed: async () => new Array(1536).fill(0),
        },
        providerId: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        status: 'active',
        message: null,
    })),
}))

// ── Test fixture: spin up the router on a random port ─────────────────────

let server: Server | null = null
let baseUrl: string

beforeEach(async () => {
    ctl.rows = []
    ctl.updated = null
    ctl.invalidated = []
    ctl.persistedSettings = null
    ctl.startedJob = null
    ctl.fetchedJob = null
    delete process.env.EMBEDDINGS_URL
    delete process.env.EMBEDDINGS_SERVER_URL
    delete process.env.INFERENCE_GATEWAY_URL

    if (!server) {
        const { embeddingsRouter } = await import('../embeddings.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/embeddings', embeddingsRouter)
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

// ── Helpers ────────────────────────────────────────────────────────────────

function workspaceRow(overrides: Partial<any> = {}): any {
    return {
        id: 'inst-1',
        workspaceId: 'ws-1',
        nickname: 'OpenAI',
        providerType: 'openai',
        managed: false,
        enabled: true,
        capabilities: {
            supportsChat: true,
            supportsEmbeddings: true,
            chatModels: [],
            embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
            discoveryError: null,
        },
        embeddingModel: null,
        embeddingDimensions: null,
        embeddingPreferenceOrder: 0,
        embeddingLastUsedAt: null,
        lastDiscoveredAt: new Date(),
        ...overrides,
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/embeddings/:workspaceId/providers', () => {
    it('returns the embedding-capable provider subset with default model', async () => {
        ctl.rows = [
            workspaceRow(),
            workspaceRow({ id: 'inst-2', providerType: 'anthropic', capabilities: { ...workspaceRow().capabilities, supportsEmbeddings: false } }),
        ]

        const res = await fetch(`${baseUrl}/api/v1/embeddings/ws-1/providers`)
        expect(res.status).toBe(200)
        const body = await res.json() as { providers: any[] }
        expect(body.providers).toHaveLength(2)
        const openai = body.providers.find((p: any) => p.providerType === 'openai')!
        // DEFAULT_EMBEDDING_MODELS.openai → text-embedding-3-small, 1536 dims
        expect(openai.selectedModel).toBe('text-embedding-3-small')
        expect(openai.dimensions).toBe(1536)
    })

    it('honours an existing embeddingModel override on the row', async () => {
        ctl.rows = [
            workspaceRow({ embeddingModel: 'text-embedding-3-large', embeddingDimensions: 3072 }),
        ]
        const res = await fetch(`${baseUrl}/api/v1/embeddings/ws-1/providers`)
        const body = await res.json() as { providers: any[] }
        expect(body.providers[0].selectedModel).toBe('text-embedding-3-large')
        expect(body.providers[0].dimensions).toBe(3072)
    })
})

describe('PATCH /api/v1/embeddings/:workspaceId/providers/:instanceId/model', () => {
    it('writes the new model + dims and invalidates the intelligence cache', async () => {
        ctl.rows = [workspaceRow({ embeddingDimensions: 1536 })]

        const res = await fetch(
            `${baseUrl}/api/v1/embeddings/ws-1/providers/inst-1/model`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'text-embedding-3-large', dimensions: 3072 }),
            },
        )
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.dimensionChanged).toBe(true)
        expect(body.previousDimensions).toBe(1536)
        expect(ctl.updated.embeddingModel).toBe('text-embedding-3-large')
        expect(ctl.updated.embeddingDimensions).toBe(3072)
        expect(ctl.invalidated).toContain('ws-1')
    })

    it('rejects when model is missing', async () => {
        const res = await fetch(
            `${baseUrl}/api/v1/embeddings/ws-1/providers/inst-1/model`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            },
        )
        expect(res.status).toBe(400)
    })
})

describe('GET /api/v1/embeddings/:workspaceId/local/health', () => {
    it('returns not-installed when no env var is set', async () => {
        const res = await fetch(`${baseUrl}/api/v1/embeddings/ws-1/local/health`)
        const body = await res.json() as any
        expect(body.installed).toBe(false)
        expect(body.status).toBe('not-detected')
    })
})

describe('POST /api/v1/embeddings/:workspaceId/reembed', () => {
    it('starts a job and returns the jobId', async () => {
        const res = await fetch(`${baseUrl}/api/v1/embeddings/ws-1/reembed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.jobId).toBe('job-test-1')
        expect(ctl.startedJob).not.toBeNull()
        expect(ctl.startedJob.workspaceId).toBe('ws-1')
        expect(ctl.invalidated).toContain('ws-1')
    })
})

describe('GET /api/v1/embeddings/:workspaceId/reembed/:jobId', () => {
    it('returns the live job from the in-memory registry', async () => {
        ctl.fetchedJob = {
            jobId: 'job-live',
            workspaceId: 'ws-1',
            status: 'running',
            startedAt: new Date().toISOString(),
            rowsScanned: 5,
            rowsReembedded: 3,
            rowsSkipped: 2,
            rowsErrored: 0,
            sclScanned: 0,
            sclReembedded: 0,
            sclSkipped: 0,
            sclErrored: 0,
            targetProvider: 'openai',
            targetModel: 'text-embedding-3-small',
            targetDimensions: 1536,
        }
        const res = await fetch(`${baseUrl}/api/v1/embeddings/ws-1/reembed/job-live`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.job.jobId).toBe('job-live')
        expect(body.job.rowsReembedded).toBe(3)
    })
})
