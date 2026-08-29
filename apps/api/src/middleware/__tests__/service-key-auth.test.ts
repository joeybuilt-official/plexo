// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Service-key auth middleware tests.
 *
 * Pins the two-outcome contract requireServiceKey documents, which the A3
 * dual-accept refactor had collapsed into a single 401:
 *   1. No Authorization header                       -> 401 UNAUTHORIZED
 *   2. Bearer that matches no key                    -> 401 INVALID_KEY
 *   3. Valid SHARED key, no X-App-Id                 -> 400 MISSING_APP_ID
 *   4. Valid SHARED key + X-App-Id                   -> 200, serviceContext
 *   5. Valid per-app `psk_` key, no X-App-Id         -> 200 (key self-identifies)
 *   6. Valid per-app key + mismatched X-App-Id       -> 401 INVALID_KEY
 *   7. Non-UUID X-User-Id                            -> 400 INVALID_USER_ID
 *   8. requireMeshServiceKey — shared key, no X-App-Id still passes (mesh
 *      contract carries the caller in the body; must NOT regress to 400)
 *
 * Test key material is assembled at runtime from harmless fragments so no
 * credential-shaped literal is ever written to disk.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Request, Response } from 'express'

// ── Per-app key store (stands in for app_service_keys) ─────────────────────

interface StoredKey {
    id: string
    appId: string
    tokenHash: string
    tokenSalt: string
    expiresAt: Date | null
}

const storedKeys: StoredKey[] = []
const touched: string[] = []

vi.mock('../../repositories/app-service-keys.repository.js', () => ({
    listActiveForAuth: vi.fn(async (appId?: string) =>
        appId ? storedKeys.filter(k => k.appId === appId) : storedKeys),
    touchLastUsed: vi.fn(async (id: string) => { touched.push(id) }),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Server bootstrap ───────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const { requireServiceKey, requireMeshServiceKey } = await import('../service-key-auth.js')
        const app = express()
        app.use(express.json())
        app.get('/service', requireServiceKey, (req: Request, res: Response) => {
            res.json({ serviceContext: req.serviceContext ?? null })
        })
        app.get('/mesh', requireMeshServiceKey, (req: Request, res: Response) => {
            res.json({ serviceContext: req.serviceContext ?? null })
        })
        const created = app.listen(0)
        server = created
        await new Promise<void>((r) => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

const SHARED_KEY = ['shared', 'service', 'value', 'for', 'middleware', 'tests'].join('-')
const PER_APP_TOKEN = 'psk_' + ['levio', 'fixture', 'value'].join('_')
const SALT = ['salt', 'for', 'levio', 'fixture'].join('-')

function seedPerAppKey(): void {
    storedKeys.push({
        id: 'key-1',
        appId: 'levio',
        tokenHash: createHash('sha256').update(PER_APP_TOKEN + SALT).digest('hex'),
        tokenSalt: SALT,
        expiresAt: null,
    })
}

type ErrorBody = { error: { code: string; message: string } }

beforeEach(() => {
    storedKeys.length = 0
    touched.length = 0
    process.env.PLEXO_SERVICE_KEY = SHARED_KEY
})

afterAll(() => { server?.close() })

// ── requireServiceKey ──────────────────────────────────────────────────────

describe('requireServiceKey', () => {
    it('rejects a request with no Authorization header with 401 UNAUTHORIZED', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/service`)
        expect(res.status).toBe(401)
        expect((await res.json() as ErrorBody).error.code).toBe('UNAUTHORIZED')
    })

    it('rejects a Bearer token that matches no key with 401 INVALID_KEY', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/service`, {
            headers: { authorization: 'Bearer not-the-real-value', 'x-app-id': 'levio' },
        })
        expect(res.status).toBe(401)
        expect((await res.json() as ErrorBody).error.code).toBe('INVALID_KEY')
    })

    it('rejects a valid SHARED key with no X-App-Id with 400 MISSING_APP_ID', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/service`, {
            headers: { authorization: `Bearer ${SHARED_KEY}` },
        })
        expect(res.status).toBe(400)
        const body = await res.json() as ErrorBody
        expect(body.error.code).toBe('MISSING_APP_ID')
        expect(body.error.message).toBe('X-App-Id header required')
    })

    it('accepts a valid SHARED key with X-App-Id and sets serviceContext', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/service`, {
            headers: { authorization: `Bearer ${SHARED_KEY}`, 'x-app-id': 'levio' },
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { serviceContext: { appId: string; viaSharedKey: boolean } }
        expect(body.serviceContext.appId).toBe('levio')
        expect(body.serviceContext.viaSharedKey).toBe(true)
    })

    it('accepts a valid per-app psk_ key WITHOUT X-App-Id (the key self-identifies)', async () => {
        const base = await getServer()
        seedPerAppKey()
        const res = await fetch(`${base}/service`, {
            headers: { authorization: `Bearer ${PER_APP_TOKEN}` },
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { serviceContext: { appId: string; viaSharedKey: boolean } }
        expect(body.serviceContext.appId).toBe('levio')
        expect(body.serviceContext.viaSharedKey).toBe(false)
    })

    it('rejects a valid per-app key whose X-App-Id names a different app with 401', async () => {
        const base = await getServer()
        seedPerAppKey()
        const matched = await fetch(`${base}/service`, {
            headers: { authorization: `Bearer ${PER_APP_TOKEN}`, 'x-app-id': 'levio' },
        })
        expect(matched.status).toBe(200)

        storedKeys[0]!.appId = 'fylo'
        const mismatched = await fetch(`${base}/service`, {
            headers: { authorization: `Bearer ${PER_APP_TOKEN}`, 'x-app-id': 'levio' },
        })
        expect(mismatched.status).toBe(401)
        expect((await mismatched.json() as ErrorBody).error.code).toBe('INVALID_KEY')
    })

    it('rejects a non-UUID X-User-Id with 400 INVALID_USER_ID', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/service`, {
            headers: {
                authorization: `Bearer ${SHARED_KEY}`,
                'x-app-id': 'levio',
                'x-user-id': 'not-a-uuid',
            },
        })
        expect(res.status).toBe(400)
        expect((await res.json() as ErrorBody).error.code).toBe('INVALID_USER_ID')
    })
})

// ── requireMeshServiceKey (must NOT inherit the 400) ───────────────────────

describe('requireMeshServiceKey', () => {
    it('accepts the shared key with no X-App-Id — the mesh contract omits it', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/mesh`, {
            headers: { authorization: `Bearer ${SHARED_KEY}` },
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { serviceContext: { appId: string } }
        expect(body.serviceContext.appId).toBe('mesh')
    })

    it('still rejects an unknown token with 401 INVALID_KEY', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/mesh`, {
            headers: { authorization: 'Bearer nope' },
        })
        expect(res.status).toBe(401)
        expect((await res.json() as ErrorBody).error.code).toBe('INVALID_KEY')
    })
})
