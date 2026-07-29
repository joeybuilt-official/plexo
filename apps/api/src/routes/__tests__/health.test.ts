// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Health route tests.
 *
 * Pins:
 *   1. GET / public response — structure, status:ok (200) vs degraded (503)
 *   2. GET / degraded when postgres down, degraded when redis down
 *   3. GET / debug token gate — correct token exposes pex field, wrong/missing does not
 *   4. GET / Bearer auth exposes extended diagnostics without requiring debug token
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Test state ─────────────────────────────────────────────────────────────

const ctl = {
    postgresOk: true,
    redisOk: true,
}

// ── Redis mock (must be stable across requests — health.ts caches the client) ──

const mockRedisClient = {
    on: vi.fn(),
    connect: vi.fn(async () => {}),
    ping: vi.fn(async () => {
        if (!ctl.redisOk) throw new Error('Redis connection refused')
    }),
}

vi.mock('redis', () => ({
    createClient: vi.fn(() => mockRedisClient),
}))

// ── DB mock ────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        execute: vi.fn(async () => {
            if (!ctl.postgresOk) throw new Error('Connection refused')
        }),
        select(_fields?: unknown) {
            return {
                from(_t: unknown) { return this },
                where(_c: unknown) { return this },
                async limit(_n: number) { return [] },
            }
        },
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
        { join: vi.fn() },
    ),
    eq: vi.fn(),
    and: vi.fn(),
    isNull: vi.fn(),
    workspaces: { id: 'workspaces.id' },
    extensionPrompts: { enabled: 'enabled', deletedAt: 'deleted_at' },
    extensionContexts: { enabled: 'enabled', deletedAt: 'deleted_at' },
    appProfiles: {},
}))

vi.mock('@plexo/agent/persistent-pool', () => ({
    workerStats: vi.fn(() => ({ active: 0, idle: 0 })),
}))

vi.mock('../ai-provider-creds.js', () => ({
    loadDecryptedAIProviders: vi.fn(async () => null),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server bootstrap ───────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const { healthRouter } = await import('../health.js')
        const app = express()
        app.use('/api/v1/health', healthRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>(r => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    ctl.postgresOk = true
    ctl.redisOk = true
    delete process.env.DEBUG_TOKEN
    vi.clearAllMocks()
    // Restore connect/ping implementations cleared by clearAllMocks
    mockRedisClient.connect.mockImplementation(async () => {})
    mockRedisClient.ping.mockImplementation(async () => {
        if (!ctl.redisOk) throw new Error('Redis connection refused')
    })
})

afterAll(() => { server?.close() })

// ── Public response structure ──────────────────────────────────────────────

describe('GET /api/v1/health — public response', () => {
    it('returns 200 with status:ok when postgres and redis are healthy', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`)
        expect(res.status).toBe(200)
        const body = await res.json() as Record<string, unknown>
        expect(body.status).toBe('ok')
        expect(typeof body.version).toBe('string')
        expect(typeof body.uptime).toBe('number')
        expect(body.services).toMatchObject({
            postgres: { ok: true },
            redis: { ok: true },
        })
    })

    it('does not expose pex or latency details in public response without auth', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`)
        expect(res.status).toBe(200)
        const body = await res.json() as Record<string, unknown>
        expect(body.pex).toBeUndefined()
        // services should only have {ok:boolean}, no latencyMs
        const services = body.services as { postgres: { ok: boolean; latencyMs?: number }; [k: string]: { ok: boolean; latencyMs?: number } }
        expect(services.postgres.latencyMs).toBeUndefined()
    })
})

// ── Degraded states ────────────────────────────────────────────────────────

describe('GET /api/v1/health — degraded states', () => {
    it('returns 503 with status:degraded when postgres is down', async () => {
        ctl.postgresOk = false
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`)
        expect(res.status).toBe(503)
        const body = await res.json() as Record<string, unknown>
        expect(body.status).toBe('degraded')
        const services = body.services as { postgres: { ok: boolean }; [k: string]: { ok: boolean } }
        expect(services.postgres.ok).toBe(false)
    })

    it('returns 503 with status:degraded when redis is down', async () => {
        ctl.redisOk = false
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`)
        expect(res.status).toBe(503)
        const body = await res.json() as Record<string, unknown>
        expect(body.status).toBe('degraded')
        const services = body.services as { redis: { ok: boolean }; [k: string]: { ok: boolean } }
        expect(services.redis.ok).toBe(false)
    })
})

// ── Debug token gate ───────────────────────────────────────────────────────

describe('GET /api/v1/health — debug token gate', () => {
    it('returns pex field when X-Debug-Token matches DEBUG_TOKEN exactly', async () => {
        process.env.DEBUG_TOKEN = 'correct-debug-token'
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`, {
            headers: { 'X-Debug-Token': 'correct-debug-token' },
        })
        const body = await res.json() as Record<string, unknown>
        expect(body.pex).toBeDefined()
        expect((body.pex as Record<string, unknown>).complianceLevel).toBe('full')
        expect((body.pex as Record<string, unknown>).specVersion).toBe('0.4.0')
    })

    it('does not expose pex when X-Debug-Token is wrong (same length, different content)', async () => {
        process.env.DEBUG_TOKEN = 'correct-debug-token'
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`, {
            headers: { 'X-Debug-Token': 'wronggg-debug-token' },
        })
        const body = await res.json() as Record<string, unknown>
        expect(body.pex).toBeUndefined()
    })

    it('does not expose pex when X-Debug-Token header is absent', async () => {
        process.env.DEBUG_TOKEN = 'correct-debug-token'
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`)
        const body = await res.json() as Record<string, unknown>
        expect(body.pex).toBeUndefined()
    })

    it('does not expose pex when DEBUG_TOKEN env var is not set', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`, {
            headers: { 'X-Debug-Token': 'anything' },
        })
        const body = await res.json() as Record<string, unknown>
        expect(body.pex).toBeUndefined()
    })
})

// ── Bearer auth gate ───────────────────────────────────────────────────────

describe('GET /api/v1/health — Bearer auth gate', () => {
    it('returns pex field when Authorization: Bearer <token> header is present', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`, {
            headers: { 'Authorization': 'Bearer some-jwt-token' },
        })
        const body = await res.json() as Record<string, unknown>
        expect(body.pex).toBeDefined()
    })

    it('does not expose pex when Authorization header is not a Bearer token', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/health/`, {
            headers: { 'Authorization': 'Basic dXNlcjpwYXNz' },
        })
        const body = await res.json() as Record<string, unknown>
        expect(body.pex).toBeUndefined()
    })
})
