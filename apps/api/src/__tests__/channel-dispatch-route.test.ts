// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * HTTP route tests for POST /api/v1/channel/dispatch.
 *
 * Pins:
 *   1. Valid request → 200 with { messageId, deliveryStatus }
 *   2. Missing Bearer → 401
 *   3. Wrong Bearer → 401
 *   4. Missing X-App-Id → 401
 *   5. Missing X-Tenant-Id → 400
 *   6. Invalid body (missing channel) → 400
 *   7. channel='unknown'-type stub (email) → 200 with deliveryStatus='not_implemented'
 *   8. Idempotency: same idempotencyKey twice → second returns same messageId
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const ctl = {
    registeredApps: new Set<string>(['levio']),
    appProfileLookups: 0,
}

vi.mock('@plexo/db', () => {
    const chainState: { lastAppId?: string } = {}
    return {
        db: {
            select: () => {
                ctl.appProfileLookups++
                const chain = {
                    from: () => chain,
                    where: (clause: { appId?: string }) => {
                        chainState.lastAppId = clause?.appId
                        return chain
                    },
                    limit: async () => {
                        const id = chainState.lastAppId
                        if (id && ctl.registeredApps.has(id)) return [{ appId: id }]
                        return []
                    },
                }
                return chain
            },
        },
        eq: (_col: unknown, val: unknown) => ({ appId: val }),
        appProfiles: { appId: 'app_profiles.app_id' },
    }
})

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


vi.mock('../redis-client.js', () => ({
    isRedisAvailable: () => false,
    getRedis: async () => { throw new Error('redis disabled in tests') },
}))

const SERVICE_KEY = 'test-plexo-service-key-12345678901234567890'

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
        const { channelDispatchRouter } = await import('../routes/channel-dispatch.js')
        const app = express()
        app.use(express.json())
        app.use('/api/v1/channel', channelDispatchRouter)

        const created = app.listen(0)
        server = created
        await new Promise<void>((r) => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(async () => {
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
    delete process.env.TELEGRAM_BOT_TOKEN
    ctl.registeredApps = new Set(['levio'])
    ctl.appProfileLookups = 0
    const { _resetIdempotencyStoreForTests } = await import('../channel-dispatch.js')
    const { _resetDispatchRouteCachesForTests } = await import('../routes/channel-dispatch.js')
    _resetIdempotencyStoreForTests()
    _resetDispatchRouteCachesForTests()
})

afterAll(() => { server?.close() })

function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        'content-type': 'application/json',
        authorization: `Bearer ${SERVICE_KEY}`,
        'x-app-id': 'levio',
        'x-tenant-id': 'tenant-1',
        'x-workspace-id': 'workspace-1',
        'x-user-id': 'user-1',
        'x-trace-id': 'trace-1',
        ...extra,
    }
}

describe('POST /api/v1/channel/dispatch', () => {
    it('1. valid request → 200 with { messageId, deliveryStatus }', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({
                channel: 'telegram',
                recipientUserId: '12345',
                message: { text: 'hello' },
                idempotencyKey: 'k-route-1',
            }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { messageId?: string; deliveryStatus?: string }
        // No TELEGRAM_BOT_TOKEN configured in tests → handler returns not_implemented cleanly
        expect(body.deliveryStatus).toBe('not_implemented')
    })

    it('2. missing Bearer → 401', async () => {
        const base = await getServer()
        const headers = authedHeaders()
        delete headers.authorization
        const res = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                channel: 'telegram',
                recipientUserId: '12345',
                message: { text: 'hello' },
                idempotencyKey: 'k-route-2',
            }),
        })
        expect(res.status).toBe(401)
        const body = await res.json() as { error: string }
        expect(body.error).toMatch(/Authorization/i)
    })

    it('3. wrong Bearer → 401', async () => {
        const base = await getServer()
        const wrong = 'X'.repeat(SERVICE_KEY.length)
        const res = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers: authedHeaders({ authorization: `Bearer ${wrong}` }),
            body: JSON.stringify({
                channel: 'telegram',
                recipientUserId: '12345',
                message: { text: 'hello' },
                idempotencyKey: 'k-route-3',
            }),
        })
        expect(res.status).toBe(401)
        const body = await res.json() as { error: string }
        expect(body.error).toMatch(/Invalid service key/i)
    })

    it('4. missing X-App-Id → 401', async () => {
        const base = await getServer()
        const headers = authedHeaders()
        delete headers['x-app-id']
        const res = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                channel: 'telegram',
                recipientUserId: '12345',
                message: { text: 'hello' },
                idempotencyKey: 'k-route-4',
            }),
        })
        expect(res.status).toBe(401)
        const body = await res.json() as { error: string }
        expect(body.error).toMatch(/X-App-Id/i)
    })

    it('4b. unregistered X-App-Id → 403', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers: authedHeaders({ 'x-app-id': 'someotherapp' }),
            body: JSON.stringify({
                channel: 'telegram',
                recipientUserId: '12345',
                message: { text: 'hello' },
                idempotencyKey: 'k-route-4b',
            }),
        })
        expect(res.status).toBe(403)
    })

    it('5. missing X-Tenant-Id → 400', async () => {
        const base = await getServer()
        const headers = authedHeaders()
        delete headers['x-tenant-id']
        const res = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                channel: 'telegram',
                recipientUserId: '12345',
                message: { text: 'hello' },
                idempotencyKey: 'k-route-5',
            }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: string; message: string }
        expect(body.error).toBe('invalid_argument')
        expect(body.message).toMatch(/X-Tenant-Id/i)
    })

    it('6. invalid body (missing channel) → 400', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({
                recipientUserId: '12345',
                message: { text: 'hello' },
                idempotencyKey: 'k-route-6',
            }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: string; message?: string }
        expect(body.error).toBe('invalid_argument')
    })

    it('7. channel=email (stub) → 200 with deliveryStatus=not_implemented', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify({
                channel: 'email',
                recipientUserId: 'user@example.com',
                message: { text: 'hello' },
                idempotencyKey: 'k-route-7',
            }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { deliveryStatus?: string }
        expect(body.deliveryStatus).toBe('not_implemented')
    })

    it('8. idempotency: same key twice → second returns same result', async () => {
        const base = await getServer()
        const args = {
            channel: 'email',
            recipientUserId: 'user@example.com',
            message: { text: 'hello' },
            idempotencyKey: 'k-route-8-same',
        }
        const r1 = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify(args),
        })
        const b1 = await r1.json() as { messageId?: string; deliveryStatus?: string }
        const r2 = await fetch(`${base}/api/v1/channel/dispatch`, {
            method: 'POST',
            headers: authedHeaders(),
            body: JSON.stringify(args),
        })
        const b2 = await r2.json() as { messageId?: string; deliveryStatus?: string }
        expect(r1.status).toBe(200)
        expect(r2.status).toBe(200)
        expect(b2).toEqual(b1)
    })
})
