// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase B integration test — web→api Better Auth handshake.
 *
 * Pins audit fix #4: a session minted by the web's Better Auth instance
 * must be accepted by the api's Better Auth middleware. Both sides go
 * through the shared factory at packages/db/src/auth/config.ts. If the
 * configs ever diverge (different secret, cookie attributes, generateId,
 * etc.) this test will fail loudly because the api middleware will return
 * 401 instead of 200.
 *
 * Runs against the dev postgres at DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import type { Auth } from 'better-auth'
import { createPlexoBetterAuth } from '@plexo/db/auth/config'
import { requireBetterAuth } from '../../apps/api/src/middleware/better-auth.js'

const TEST_PASSWORD = 'Phase-B-Test-Password-1234!'
const BASE_URL = 'http://localhost:9876'
const TRUSTED_ORIGINS = ['http://localhost:9876']

let webAuth: Auth
let apiAuth: Auth
let webPool: Pool
let apiPool: Pool
let server: import('node:http').Server
let baseUrl: string
const createdEmails: string[] = []

function uniqueEmail(label: string): string {
    const email = `test-handshake-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
    createdEmails.push(email)
    return email
}

function makeAuth(pool: Pool): Auth {
    return createPlexoBetterAuth({
        pool,
        secret: process.env.AUTH_SECRET!,
        baseURL: BASE_URL,
        trustedOrigins: TRUSTED_ORIGINS,
        secureCookies: false,
    })
}

function extractSessionCookie(headers: Headers): string {
    // Better Auth's responseHeaders aggregates set-cookie values.
    // Headers#getSetCookie is the standard way to read them as a list (Node 20+).
    const setCookies =
        typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
            ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
            : (headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/g)
    const sessionCookies = setCookies
        .map((line) => line.split(';')[0])
        .filter((kv) => kv.startsWith('better-auth.session_token=') || kv.startsWith('better-auth.session_data='))
    if (sessionCookies.length === 0) {
        throw new Error(`No better-auth session cookie in Set-Cookie: ${JSON.stringify(setCookies)}`)
    }
    return sessionCookies.join('; ')
}

beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set')
    process.env.AUTH_DATABASE_URL ??= process.env.DATABASE_URL
    process.env.AUTH_SECRET ??= 'test-secret-32-bytes-aaaaaaaaaaaaaaaa'

    const setSearchPath = (client: { query: (sql: string) => Promise<unknown> }) => {
        client.query('SET search_path TO auth').catch(() => {})
    }

    webPool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL })
    webPool.on('connect', setSearchPath)
    apiPool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL })
    apiPool.on('connect', setSearchPath)

    webAuth = makeAuth(webPool)
    apiAuth = makeAuth(apiPool)
    // Touch apiAuth so the lazy instance has been initialised before requests arrive.
    expect(apiAuth.api).toBeDefined()

    const app = express()
    app.use(express.json())
    app.get('/api/v1/workspaces', requireBetterAuth, (_req, res) => {
        res.status(200).json({ workspaces: [] })
    })

    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (createdEmails.length > 0) {
        const cleanup = new Pool({ connectionString: process.env.AUTH_DATABASE_URL })
        try {
            await cleanup.query(
                `DELETE FROM auth."session" WHERE "userId" IN (SELECT id FROM auth."user" WHERE email = ANY($1::text[]))`,
                [createdEmails],
            )
            await cleanup.query(
                `DELETE FROM auth."account" WHERE "userId" IN (SELECT id FROM auth."user" WHERE email = ANY($1::text[]))`,
                [createdEmails],
            )
            await cleanup.query(`DELETE FROM auth."user" WHERE email = ANY($1::text[])`, [createdEmails])
        } finally {
            await cleanup.end()
        }
    }
    if (webPool) await webPool.end()
    if (apiPool) await apiPool.end()
})

describe('Phase B — web↔api Better Auth handshake', () => {
    it('cookie path: web-minted session cookie is accepted by api requireBetterAuth', async () => {
        const email = uniqueEmail('cookie')

        const signUp = (await webAuth.api.signUpEmail({
            body: { email, password: TEST_PASSWORD, name: 'Phase B Cookie' },
            returnHeaders: true,
        })) as { headers: Headers; response: { token: string | null; user: { id: string; email: string } } }

        expect(signUp.response.user.email).toBe(email)
        const cookieHeader = extractSessionCookie(signUp.headers)

        const res = await fetch(`${baseUrl}/api/v1/workspaces`, {
            headers: { cookie: cookieHeader },
        })

        if (res.status !== 200) {
            const body = await res.text()
            throw new Error(`Expected 200, got ${res.status}: ${body}`)
        }
        const body = (await res.json()) as { workspaces: unknown[] }
        expect(body).toEqual({ workspaces: [] })
    })

    // Better Auth's Bearer-header authentication path requires the `bearer()`
    // plugin to be registered on both the issuer (web) and the verifier (api).
    // The shared factory at packages/db/src/auth/config.ts now enables it, so a
    // session token minted by signInEmail is accepted as `Authorization: Bearer`.
    // This is the channel the native Flutter client uses (ADR-0001 Phase 1).
    it('bearer path: signIn token is accepted via Authorization: Bearer (requires bearer() plugin)', async () => {
        const email = uniqueEmail('bearer')

        await webAuth.api.signUpEmail({
            body: { email, password: TEST_PASSWORD, name: 'Phase B Bearer' },
            returnHeaders: true,
        })

        const signIn = (await webAuth.api.signInEmail({
            body: { email, password: TEST_PASSWORD },
            returnHeaders: true,
        })) as {
            headers: Headers
            response: { token?: string | null; user: { id: string; email: string } }
        }

        const token =
            signIn.response.token ??
            signIn.headers.get('set-auth-token') ??
            signIn.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
            null

        expect(token).toBeTruthy()

        const res = await fetch(`${baseUrl}/api/v1/workspaces`, {
            headers: { authorization: `Bearer ${token}` },
        })

        expect(res.status).toBe(200)
    })
})
