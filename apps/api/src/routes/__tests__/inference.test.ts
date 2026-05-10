// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Inference shim tests — Phase 3a of ADR 0010 / ADR 0011.
 * Pins:
 *   1. Single-string and array inputs both shape correctly to OpenAI response
 *   2. Workspace ID header required + must be UUID
 *   3. Bearer service-key auth required (delegates to requireServiceKey)
 *   4. Embedding adapter null → 502, missing input → 400, empty array → 400
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

vi.mock('@plexo/agent/memory/store', () => ({
    embed: vi.fn(),
}))

const { embed } = await import('@plexo/agent/memory/store')
const { inferenceRouter } = await import('../inference.js')

const SERVICE_KEY = 'test-service-key-1234567890abcd'
const VALID_WORKSPACE = '00000000-0000-0000-0000-000000000001'

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const app = express()
        app.use(express.json())
        app.use('/api/inference', inferenceRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>(r => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
    vi.clearAllMocks()
})

afterAll(() => { server?.close() })

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_KEY}`,
        'X-App-Id': 'test-suite',
        'X-Plexo-Workspace-Id': VALID_WORKSPACE,
        ...extra,
    }
}

describe('POST /api/inference/v1/embeddings', () => {
    it('returns OpenAI-shaped response for a single string input', async () => {
        vi.mocked(embed).mockResolvedValueOnce(new Array(256).fill(0.1))
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ input: 'hello world', model: 'plexo-embeddings/256' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { object: string; data: Array<{ index: number; embedding: number[] }>; model: string }
        expect(body.object).toBe('list')
        expect(body.data).toHaveLength(1)
        expect(body.data[0]!.embedding).toHaveLength(256)
        expect(body.data[0]!.index).toBe(0)
        expect(body.model).toBe('plexo-embeddings/256')
        expect(embed).toHaveBeenCalledWith('hello world', VALID_WORKSPACE)
    })

    it('handles array input with one embed call per element', async () => {
        vi.mocked(embed)
            .mockResolvedValueOnce(new Array(256).fill(0.2))
            .mockResolvedValueOnce(new Array(256).fill(0.3))
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ input: ['first', 'second'] }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { data: Array<{ index: number; embedding: number[] }> }
        expect(body.data).toHaveLength(2)
        expect(body.data[1]!.index).toBe(1)
        expect(embed).toHaveBeenCalledTimes(2)
    })

    it('rejects requests without X-Plexo-Workspace-Id', async () => {
        const headers = authHeaders()
        delete headers['X-Plexo-Workspace-Id']
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_WORKSPACE_ID')
    })

    it('rejects non-UUID workspace ID', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders({ 'X-Plexo-Workspace-Id': 'not-a-uuid' }),
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(400)
    })

    it('rejects requests without service-key Bearer auth', async () => {
        const headers = authHeaders()
        delete headers.Authorization
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(401)
    })

    it('returns 502 when the embedding adapter returns null', async () => {
        vi.mocked(embed).mockResolvedValueOnce(null)
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ input: 'hello' }),
        })
        expect(res.status).toBe(502)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('EMBEDDING_PROVIDER_ERROR')
    })

    it('returns 400 on missing input', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('MISSING_INPUT')
    })

    it('returns 400 on empty array input', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/inference/v1/embeddings`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ input: [] }),
        })
        expect(res.status).toBe(400)
    })
})
