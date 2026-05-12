// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Training-data contract fuzz tests.
 *
 * Exercises the training-data route against adversarial inputs:
 *   1. Unknown / injected source IDs → 404, not 500
 *   2. Invalid sources array in POST /export → 400, not 500
 *   3. Oversized payloads → 413, not 500
 *   4. SQL injection probes → blocked by source-ID allowlist
 *   5. Every error response has shape: { error: { code: string, message: string } }
 *
 * Note: GET /sources success paths are not tested here (no user-controlled
 * input to fuzz). This file focuses exclusively on adversarial inputs.
 */

import { describe, it, expect, vi, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        execute: vi.fn(async () => []),
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
        {
            raw: (s: string) => s,
            identifier: (s: string) => s,
            join: vi.fn(),
        }
    ),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server helpers ────────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function ensureServer(): Promise<string> {
    if (server) return baseUrl
    const { trainingDataRouter } = await import('../training-data.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1/training', trainingDataRouter)
    server = app.listen(0)
    await new Promise<void>(r => server!.once('listening', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return baseUrl
}

afterAll(() => { server?.close() })

// ── Assertion helper ──────────────────────────────────────────────────────────

function assertErrorShape(body: unknown) {
    const b = body as any
    expect(b.error, 'error must be an object').toBeTypeOf('object')
    expect(b.error, 'error must not be null').not.toBeNull()
    expect(typeof b.error.code, 'error.code must be a string').toBe('string')
    expect(b.error.code.length, 'error.code must be non-empty').toBeGreaterThan(0)
    expect(typeof b.error.message, 'error.message must be a string').toBe('string')
    expect(b.error.message.length, 'error.message must be non-empty').toBeGreaterThan(0)
}

const DROP_TABLE = "'; DROP TABLE inference_logs--"
const VALID_SOURCES = ['inference_logs', 'conversations', 'task_steps']

// ─────────────────────────────────────────────────────────────────────────────
// 1. Unknown / injected source IDs → 404 NOT_FOUND
// ─────────────────────────────────────────────────────────────────────────────

describe('unknown source → 404 NOT_FOUND', () => {
    it('GET /sources/:source/sample — unknown source ID', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/sources/nonexistent_source/sample`)
        expect(res.status).toBe(404)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('NOT_FOUND')
    })

    it('GET /sources/:source/sample — empty string source', async () => {
        // Express route won't match an empty segment — but this tests adjacent guard.
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/sources/unknown_empty/sample`)
        expect(res.status).toBe(404)
        assertErrorShape(await res.json())
    })

    it('GET /sources/:source/sample — numeric source ID', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/sources/12345/sample`)
        expect(res.status).toBe(404)
        assertErrorShape(await res.json())
    })

    it('GET /sources/:source/sample — path traversal attempt', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/training/sources/${encodeURIComponent('../../../etc/passwd')}/sample`
        )
        expect(res.status).toBe(404)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Invalid sources array in POST /export → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid sources for POST /export → 400, not 500', () => {
    it('POST /export — sources is not an array (string)', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: 'inference_logs' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_SOURCES')
    })

    it('POST /export — sources is a number', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: 42 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_SOURCES')
    })

    it('POST /export — sources is null', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: null }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /export — sources is an empty array', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: [] }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_SOURCES')
    })

    it('POST /export — body has no sources key', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /export — all source IDs are unrecognized', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: ['does_not_exist', 'also_fake'] }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('NO_VALID_SOURCES')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Oversized payload → 413, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413, not 500', () => {
    it('POST /export — body exceeds 1 MB limit', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sources: VALID_SOURCES,
                extra: 'x'.repeat(1_100_000),
            }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. SQL injection probes → blocked by source-ID allowlist
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → blocked by source-ID allowlist', () => {
    it('GET /sources/:source/sample — DROP TABLE injection in source → 404', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/training/sources/${encodeURIComponent(DROP_TABLE)}/sample`
        )
        // DATA_SOURCES.find() sees no match — 404, not 500.
        expect(res.status).toBe(404)
        assertErrorShape(await res.json())
    })

    it('GET /sources/:source/sample — OR-based injection in source → 404', async () => {
        const base = await ensureServer()
        const res = await fetch(
            `${base}/api/v1/training/sources/${encodeURIComponent('" OR "1"="1')}/sample`
        )
        expect(res.status).toBe(404)
        assertErrorShape(await res.json())
    })

    it('POST /export — injection in sources array → 400 NO_VALID_SOURCES (allowlist filter)', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: [DROP_TABLE, '" UNION SELECT--'] }),
        })
        // The injected strings don't match any DATA_SOURCES id — all filtered out.
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('NO_VALID_SOURCES')
    })

    it('POST /export — injection mixed with one valid source → streams valid source only', async () => {
        const base = await ensureServer()
        const res = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sources: ['conversations', DROP_TABLE],
            }),
        })
        // 'conversations' is valid → export starts (200), injection ID is ignored.
        expect(res.status).toBe(200)
        expect(res.status).not.toBe(500)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code: string, message: string } }', () => {
    it('NOT_FOUND on sample has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(`${base}/api/v1/training/sources/unknown_source/sample`).then(r => r.json())
        assertErrorShape(body)
    })

    it('INVALID_SOURCES on export has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: 'not-array' }),
        }).then(r => r.json())
        assertErrorShape(body)
    })

    it('NO_VALID_SOURCES on export has message field', async () => {
        const base = await ensureServer()
        const body = await fetch(`${base}/api/v1/training/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: ['invalid_source_id'] }),
        }).then(r => r.json())
        assertErrorShape(body)
    })
})
