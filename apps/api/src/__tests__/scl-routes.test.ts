// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * HTTP route tests for /api/v1/scl/* (ADR 0008).
 *
 * Pins:
 *   1. Each route returns 401 without service key.
 *   2. Each route returns 400 on missing/invalid workspaceId.
 *   3. Happy path returns the shape nexalog expects.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const calls = {
    mutate: [] as Array<{ workspaceId: string; concepts: unknown[]; source: string }>,
    expand: [] as Array<{ workspaceId: string; stimulus: string; opts: { depth?: number; width?: number } }>,
    meta: [] as string[],
    trigger: [] as Array<{ workspaceId: string; source: string; sourceLogId?: string }>,
}

vi.mock('@plexo/agent/memory/scl-query', () => ({
    mutateConceptGraph: vi.fn(async (workspaceId: string, concepts: unknown[], source: string) => {
        calls.mutate.push({ workspaceId, concepts, source })
        return { added: concepts.length, total: concepts.length }
    }),
    expandConceptGraph: vi.fn(async (workspaceId: string, stimulus: string, opts: { depth?: number; width?: number } = {}) => {
        calls.expand.push({ workspaceId, stimulus, opts })
        return { nodes: [{ id: 'c1', label: 'Test', type: 'claim' }], truncated: false }
    }),
    getGoldenRecordMeta: vi.fn(async (workspaceId: string) => {
        calls.meta.push(workspaceId)
        return { enabled: true, version: 1, regionCount: 3 }
    }),
    triggerSclExtract: vi.fn(async (workspaceId: string, source: string, sourceLogId?: string) => {
        calls.trigger.push({ workspaceId, source, sourceLogId })
        return { ok: true as const }
    }),
}))

const SERVICE_KEY = 'test-plexo-service-key-1234567890abcdefghij'
const APP_ID = 'nexalog'
const WORKSPACE = '11111111-1111-1111-1111-111111111111'

let server: Server | null = null
let baseUrl: string

beforeAll(async () => {
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
    const { sclRouter } = await import('../routes/scl.js')
    const app = express()
    app.use(express.json())
    app.use('/api/v1/scl', sclRouter)
    const created = app.listen(0)
    server = created
    await new Promise<void>((r) => created.once('listening', () => r()))
    baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
})

function authedHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_KEY}`,
        'X-App-Id': APP_ID,
    }
}

describe('POST /api/v1/scl/mutate', () => {
    it('401 without bearer', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WORKSPACE, concepts: [{ label: 'x', type: 'claim' }] }),
        })
        expect(r.status).toBe(401)
    })

    it('400 on invalid workspaceId', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/mutate`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: 'not-a-uuid', concepts: [{ label: 'x', type: 'claim' }] }),
        })
        expect(r.status).toBe(400)
    })

    it('400 on missing concepts', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/mutate`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WORKSPACE, concepts: [] }),
        })
        expect(r.status).toBe(400)
    })

    it('200 happy path', async () => {
        calls.mutate = []
        const r = await fetch(`${baseUrl}/api/v1/scl/mutate`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({
                workspaceId: WORKSPACE,
                concepts: [{ label: 'Plexo SDK', type: 'claim' }],
                source: 'nexalog-note-create',
            }),
        })
        expect(r.status).toBe(200)
        const body = await r.json() as { ok: boolean; added: number; total: number }
        expect(body.ok).toBe(true)
        expect(body.added).toBe(1)
        expect(calls.mutate[0]?.source).toBe('nexalog-note-create')
    })
})

describe('POST /api/v1/scl/expand', () => {
    it('401 without bearer', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/expand`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WORKSPACE, stimulus: 'plexo' }),
        })
        expect(r.status).toBe(401)
    })

    it('400 on missing stimulus', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/expand`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WORKSPACE }),
        })
        expect(r.status).toBe(400)
    })

    it('200 happy path returns nodes + truncated', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/expand`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WORKSPACE, stimulus: 'plexo', level: 'L1', contextBudget: 1000 }),
        })
        expect(r.status).toBe(200)
        const body = await r.json() as { nodes: unknown[]; truncated: boolean }
        expect(Array.isArray(body.nodes)).toBe(true)
        expect(body.nodes.length).toBe(1)
        expect(body.truncated).toBe(false)
    })
})

describe('GET /api/v1/scl/record/meta', () => {
    it('401 without bearer', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/record/meta?workspaceId=${WORKSPACE}`)
        expect(r.status).toBe(401)
    })

    it('400 on missing workspaceId', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/record/meta`, { headers: authedHeaders() })
        expect(r.status).toBe(400)
    })

    it('200 returns meta with enabled flag', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/record/meta?workspaceId=${WORKSPACE}`, {
            headers: authedHeaders(),
        })
        expect(r.status).toBe(200)
        const body = await r.json() as { enabled: boolean; version?: number }
        expect(body.enabled).toBe(true)
        expect(body.version).toBe(1)
    })
})

describe('POST /api/v1/scl/extract/trigger', () => {
    it('401 without bearer', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/extract/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WORKSPACE }),
        })
        expect(r.status).toBe(401)
    })

    it('400 on invalid sourceLogId', async () => {
        const r = await fetch(`${baseUrl}/api/v1/scl/extract/trigger`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WORKSPACE, sourceLogId: 'not-a-uuid' }),
        })
        expect(r.status).toBe(400)
    })

    it('200 happy path', async () => {
        calls.trigger = []
        const r = await fetch(`${baseUrl}/api/v1/scl/extract/trigger`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({ workspaceId: WORKSPACE, source: 'nexalog.embeddings.cluster' }),
        })
        expect(r.status).toBe(200)
        const body = await r.json() as { ok: boolean }
        expect(body.ok).toBe(true)
        expect(calls.trigger[0]?.source).toBe('nexalog.embeddings.cluster')
    })
})
