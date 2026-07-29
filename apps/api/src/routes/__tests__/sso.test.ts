// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SSO route tests.
 *
 * Pins:
 *   1. Feature flag off -> 503 on both endpoints
 *   2. Handoff: bad app slug -> 400
 *   3. Handoff: mismatched return URL host -> 400
 *   4. Handoff: no session -> 302 to /auth/login
 *   5. Handoff: session present -> 302 to return URL with sso_token
 *   6. Verify: bad HMAC -> 401
 *   7. Verify: expired token -> 401
 *   8. Verify: replay (token reuse) -> 401
 *   9. Verify: valid+fresh -> 200 with userId+email
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const SECRET = 'c'.repeat(64)
const USER_ID = '99999999-8888-7777-6666-555555555555'
const USER_EMAIL = 'agent-test@example.com'

// ── Test state ─────────────────────────────────────────────────────────────

const ctl = {
    sessionUser: null as null | { id: string; email: string; role: 'admin' | 'member'; isSuperAdmin: boolean },
    redisStore: new Map<string, string>(),
    /** When true, getRedis throws — used to test the STATE_UNAVAILABLE path. */
    redisThrows: false,
    /** When true, the auth.user lookup returns no rows. */
    userMissing: false,
}

function resetCtl() {
    ctl.sessionUser = null
    ctl.redisStore = new Map()
    ctl.redisThrows = false
    ctl.userMissing = false
}

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../middleware/auth.js', () => ({
    optionalAuth: (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
        if (ctl.sessionUser) req.user = ctl.sessionUser
        next()
    },
    requireAuth: (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
        if (ctl.sessionUser) {
            req.user = ctl.sessionUser
            next()
            return
        }
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'no session' } })
    },
}))

vi.mock('../../redis-client.js', () => ({
    getRedis: async () => {
        if (ctl.redisThrows) throw new Error('redis down')
        return {
            async set(key: string, value: string, opts?: { NX?: boolean; EX?: number }) {
                if (opts?.NX && ctl.redisStore.has(key)) return null
                ctl.redisStore.set(key, value)
                return 'OK'
            },
            async get(key: string) {
                return ctl.redisStore.get(key) ?? null
            },
        }
    },
}))

vi.mock('@plexo/db', () => ({
    db: {
        execute: async (_q: unknown) => {
            if (ctl.userMissing) return [] as Array<{ email: string }>
            return [{ email: USER_EMAIL }]
        },
    },
    sql: (strings: TemplateStringsArray, ..._args: unknown[]) => strings.join('?'),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Test harness ───────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl = ''

beforeEach(async () => {
    resetCtl()
    vi.clearAllMocks()

    process.env.PLEXO_SSO_ENABLED = 'true'
    process.env.SSO_HANDOFF_SECRET = SECRET
    process.env.PUBLIC_URL = 'https://getplexo.com'

    if (!server) {
        const { ssoRouter } = await import('../sso.js')
        const app = express()
        app.use(express.json())
        app.use('/api/sso', ssoRouter)
        await new Promise<void>((resolve) => {
            server = app.listen(0, () => resolve())
        })
        const addr = server!.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${addr.port}`
    }
})

afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
})

// ── Helpers ────────────────────────────────────────────────────────────────

async function mintFreshToken(args?: { ttlSeconds?: number; userId?: string; appSlug?: string }): Promise<string> {
    const { mintToken } = await import('../../sso/token.js')
    const { token } = mintToken(SECRET, {
        userId: args?.userId ?? USER_ID,
        appSlug: args?.appSlug ?? 'koforje',
        ttlSeconds: args?.ttlSeconds,
    })
    return token
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/sso/handoff — feature flag', () => {
    it('returns 503 when PLEXO_SSO_ENABLED is not "true"', async () => {
        process.env.PLEXO_SSO_ENABLED = 'false'
        const r = await fetch(`${baseUrl}/api/sso/handoff?app=koforje&return=https://koforje.com/auth/cb`, { redirect: 'manual' })
        expect(r.status).toBe(503)
        const body = await r.json() as { error?: { code?: string } }
        expect(body.error?.code).toBe('SSO_DISABLED')
    })

    it('returns 503 when SSO_HANDOFF_SECRET is missing', async () => {
        delete process.env.SSO_HANDOFF_SECRET
        const r = await fetch(`${baseUrl}/api/sso/handoff?app=koforje&return=https://koforje.com/auth/cb`, { redirect: 'manual' })
        expect(r.status).toBe(503)
    })
})

describe('GET /api/sso/handoff — validation', () => {
    it('rejects an unknown app slug with 400', async () => {
        const r = await fetch(`${baseUrl}/api/sso/handoff?app=evilapp&return=https://evilapp.com/cb`, { redirect: 'manual' })
        expect(r.status).toBe(400)
        const body = await r.json() as { error?: { code?: string } }
        expect(body.error?.code).toBe('INVALID_APP_SLUG')
    })

    it('rejects a return URL whose host does not match the slug', async () => {
        const r = await fetch(`${baseUrl}/api/sso/handoff?app=koforje&return=https://evil.com/cb`, { redirect: 'manual' })
        expect(r.status).toBe(400)
        const body = await r.json() as { error?: { code?: string } }
        expect(body.error?.code).toBe('INVALID_RETURN_URL')
    })

    it('rejects an http (non-localhost) return URL', async () => {
        const r = await fetch(`${baseUrl}/api/sso/handoff?app=koforje&return=http://koforje.com/cb`, { redirect: 'manual' })
        expect(r.status).toBe(400)
    })
})

describe('GET /api/sso/handoff — auth flow', () => {
    it('redirects to /auth/login when no session is present', async () => {
        ctl.sessionUser = null
        const r = await fetch(`${baseUrl}/api/sso/handoff?app=koforje&return=https://koforje.com/auth/cb`, { redirect: 'manual' })
        expect(r.status).toBe(302)
        const loc = r.headers.get('location') ?? ''
        expect(loc).toContain('/auth/login')
        expect(loc).toContain('next=')
    })

    it('mints token + redirects to return URL when a session is present', async () => {
        ctl.sessionUser = { id: USER_ID, email: USER_EMAIL, role: 'member', isSuperAdmin: false }
        const r = await fetch(`${baseUrl}/api/sso/handoff?app=koforje&return=https://koforje.com/auth/cb`, { redirect: 'manual' })
        expect(r.status).toBe(302)
        const loc = r.headers.get('location') ?? ''
        const u = new URL(loc)
        expect(u.hostname).toBe('koforje.com')
        expect(u.pathname).toBe('/auth/cb')
        expect(u.searchParams.get('sso_token')).toBeTruthy()
    })
})

describe('POST /api/sso/verify', () => {
    it('returns 503 when feature flag is off', async () => {
        process.env.PLEXO_SSO_ENABLED = 'false'
        const r = await fetch(`${baseUrl}/api/sso/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: 'x', appSlug: 'koforje' }),
        })
        expect(r.status).toBe(503)
    })

    it('rejects bad HMAC with 401', async () => {
        const r = await fetch(`${baseUrl}/api/sso/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: 'deadbeef.cafebabe', appSlug: 'koforje' }),
        })
        expect(r.status).toBe(401)
    })

    it('rejects expired tokens with 401', async () => {
        const expired = await mintFreshToken({ ttlSeconds: -10 })
        const r = await fetch(`${baseUrl}/api/sso/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: expired, appSlug: 'koforje' }),
        })
        expect(r.status).toBe(401)
    })

    it('rejects token reuse on second call', async () => {
        const token = await mintFreshToken()
        const first = await fetch(`${baseUrl}/api/sso/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, appSlug: 'koforje' }),
        })
        expect(first.status).toBe(200)

        const second = await fetch(`${baseUrl}/api/sso/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, appSlug: 'koforje' }),
        })
        expect(second.status).toBe(401)
        const body = await second.json() as { error?: { code?: string } }
        expect(body.error?.code).toBe('TOKEN_USED')
    })

    it('accepts a valid + fresh token, returns userId and email', async () => {
        const token = await mintFreshToken()
        const r = await fetch(`${baseUrl}/api/sso/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, appSlug: 'koforje' }),
        })
        expect(r.status).toBe(200)
        const body = await r.json() as { valid: boolean; userId: string; email: string }
        expect(body.valid).toBe(true)
        expect(body.userId).toBe(USER_ID)
        expect(body.email).toBe(USER_EMAIL)
    })

    it('rejects mismatched appSlug claim with 401', async () => {
        const token = await mintFreshToken({ appSlug: 'koforje' })
        const r = await fetch(`${baseUrl}/api/sso/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, appSlug: 'levio' }),
        })
        expect(r.status).toBe(401)
    })
})
