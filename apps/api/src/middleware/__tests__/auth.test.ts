// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Auth middleware dispatch tests.
 *
 * Pins:
 *   1. Internal service key (X-Plexo-Service-Key + X-Plexo-User-Id) — success path
 *   2. Internal service key — wrong key length -> falls through to provider
 *   3. Internal service key — correct length wrong value -> falls through
 *   4. Internal service key — non-UUID user id -> falls through
 *   5. Internal service key — user not found in DB -> falls through
 *   6. Internal service key — isSuperAdmin derived from SUPER_ADMIN_EMAILS
 *   7. App service key (Bearer + X-App-Id) — success sets serviceContext
 *   8. App service key — wrong token -> falls through to provider
 *   9. requireAuth with no service key -> delegates to better-auth
 *  10. optionalAuth — always calls next() even without any session
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Request, Response, NextFunction } from 'express'

// ── DB mock state ──────────────────────────────────────────────────────────

const dbQueue: unknown[] = []

function dequeue(): unknown { return dbQueue.shift() ?? [] }
function enqueue(...items: unknown[]): void { dbQueue.push(...items) }

function makeSelectChain(): Record<string, unknown> {
    const result = Promise.resolve().then(dequeue)
    const chain: Record<string, unknown> = {
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => result.then(res, rej),
        catch: (rej: (e: unknown) => unknown) => result.catch(rej),
        from: () => chain,
        where: () => chain,
        limit: () => result,
    }
    return chain
}

// ── Provider mock state ────────────────────────────────────────────────────

const providers = {
    betterAuthPasses: false,
}

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        select: (_f?: unknown) => makeSelectChain(),
    },
    eq: () => undefined,
    users: {},
}))

vi.mock('../better-auth.js', () => ({
    requireBetterAuth: vi.fn((req: Request, res: Response, next: NextFunction) => {
        if (providers.betterAuthPasses) {
            (req as unknown as { user: { id: string } }).user = { id: 'better-auth-user' }
            next()
        } else {
            res.status(401).json({ error: 'Unauthorized' })
        }
    }),
    optionalBetterAuth: vi.fn((_req: Request, _res: Response, next: NextFunction) => { next() }),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server bootstrap ───────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const { requireAuth, optionalAuth } = await import('../auth.js')
        const app = express()
        app.use(express.json())

        // Protected route
        app.get('/protected', requireAuth, (req: Request, res: Response) => {
            res.json({ user: (req as unknown as { user?: unknown }).user ?? null })
        })

        // Service context route — for app-service-key tests
        app.get('/service', requireAuth, (req: Request, res: Response) => {
            res.json({ serviceContext: (req as unknown as { serviceContext?: unknown }).serviceContext ?? null })
        })

        // Optional auth route
        app.get('/optional', optionalAuth, (req: Request, res: Response) => {
            res.json({ user: (req as unknown as { user?: unknown }).user ?? null })
        })

        const created = app.listen(0)
        server = created
        await new Promise<void>((r) => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

beforeEach(() => {
    dbQueue.length = 0
    providers.betterAuthPasses = false
    delete process.env.PLEXO_SERVICE_KEY
    delete process.env.SUPER_ADMIN_EMAILS
})

afterAll(() => { server?.close() })

// ── Internal service key ───────────────────────────────────────────────────

const SERVICE_KEY = 'test-service-key-for-auth-tests'
const VALID_UUID = '12345678-1234-1234-1234-123456789012'
const VALID_UUID_2 = '87654321-4321-4321-4321-210987654321'

describe('requireAuth — internal service key (X-Plexo-Service-Key)', () => {
    it('authenticates when key and user-id are correct and user exists in DB', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
        enqueue([{ id: VALID_UUID, email: 'user@example.com' }])

        const res = await fetch(`${base}/protected`, {
            headers: {
                'x-plexo-service-key': SERVICE_KEY,
                'x-plexo-user-id': VALID_UUID,
            },
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { user: { id: string; email: string } }
        expect(body.user.id).toBe(VALID_UUID)
        expect(body.user.email).toBe('user@example.com')
    })

    it('marks isSuperAdmin true when user email is in SUPER_ADMIN_EMAILS', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
        process.env.SUPER_ADMIN_EMAILS = 'super@example.com'
        enqueue([{ id: VALID_UUID_2, email: 'super@example.com' }])

        const res = await fetch(`${base}/protected`, {
            headers: {
                'x-plexo-service-key': SERVICE_KEY,
                'x-plexo-user-id': VALID_UUID_2,
            },
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { user: { isSuperAdmin: boolean; role: string } }
        expect(body.user.isSuperAdmin).toBe(true)
        expect(body.user.role).toBe('admin')
    })

    it('falls through when key length differs from expected', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY

        // shorter key -> length mismatch -> timing-safe compare skipped -> falls through
        const res = await fetch(`${base}/protected`, {
            headers: {
                'x-plexo-service-key': 'short',
                'x-plexo-user-id': VALID_UUID,
            },
        })
        expect(res.status).toBe(401)
    })

    it('falls through when key value is wrong but same length', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
        const wrongKey = 'X'.repeat(SERVICE_KEY.length)

        const res = await fetch(`${base}/protected`, {
            headers: {
                'x-plexo-service-key': wrongKey,
                'x-plexo-user-id': VALID_UUID,
            },
        })
        expect(res.status).toBe(401)
    })

    it('falls through when x-plexo-user-id is not a valid UUID', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY

        const res = await fetch(`${base}/protected`, {
            headers: {
                'x-plexo-service-key': SERVICE_KEY,
                'x-plexo-user-id': 'not-a-uuid',
            },
        })
        expect(res.status).toBe(401)
    })

    it('falls through when user is not found in the DB', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
        enqueue([]) // empty result -> user not found

        // Use a UUID that has NOT been cached by prior tests
        const UNCACHED_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
        const res = await fetch(`${base}/protected`, {
            headers: {
                'x-plexo-service-key': SERVICE_KEY,
                'x-plexo-user-id': UNCACHED_UUID,
            },
        })
        expect(res.status).toBe(401)
    })
})

// ── App service key ────────────────────────────────────────────────────────

describe('requireAuth — app service key (Bearer + X-App-Id)', () => {
    it('authenticates and sets serviceContext when token and app-id are provided', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY

        const res = await fetch(`${base}/service`, {
            headers: {
                Authorization: `Bearer ${SERVICE_KEY}`,
                'x-app-id': 'levio',
            },
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { serviceContext: { appId: string } }
        expect(body.serviceContext.appId).toBe('levio')
    })

    it('falls through when x-app-id header is missing', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY

        const res = await fetch(`${base}/service`, {
            headers: {
                Authorization: `Bearer ${SERVICE_KEY}`,
                // no x-app-id
            },
        })
        expect(res.status).toBe(401)
    })

    it('falls through when Bearer token length differs from service key', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY

        const res = await fetch(`${base}/service`, {
            headers: {
                Authorization: 'Bearer wrong-token',
                'x-app-id': 'levio',
            },
        })
        expect(res.status).toBe(401)
    })
})

// ── Provider dispatch ──────────────────────────────────────────────────────

describe('requireAuth — provider dispatch', () => {
    it('delegates to better-auth (default)', async () => {
        const base = await getServer()
        providers.betterAuthPasses = true
        // no PLEXO_SERVICE_KEY -> skips service key checks

        const res = await fetch(`${base}/protected`)
        expect(res.status).toBe(200)
    })

    it('returns 401 when neither service key nor provider session is present', async () => {
        const base = await getServer()
        // betterAuthPasses = false (default) -> 401

        const res = await fetch(`${base}/protected`)
        expect(res.status).toBe(401)
    })
})

// ── optionalAuth ───────────────────────────────────────────────────────────

describe('optionalAuth', () => {
    it('always calls next() even when no session is present', async () => {
        const base = await getServer()
        // optionalBetterAuth mock always calls next()

        const res = await fetch(`${base}/optional`)
        expect(res.status).toBe(200)
        const body = await res.json() as { user: null }
        expect(body.user).toBeNull()
    })

    it('attaches user when valid internal service key is supplied', async () => {
        const base = await getServer()
        process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
        const OPT_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        enqueue([{ id: OPT_UUID, email: 'opt@example.com' }])

        const res = await fetch(`${base}/optional`, {
            headers: {
                'x-plexo-service-key': SERVICE_KEY,
                'x-plexo-user-id': OPT_UUID,
            },
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { user: { id: string } }
        expect(body.user.id).toBe(OPT_UUID)
    })
})
