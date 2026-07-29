// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * HTTP route tests for the Jex identity mesh (ADR-0016 B3).
 *
 * Pins:
 *   1. POST recognition, missing Bearer            → 401
 *   2. POST recognition, wrong Bearer              → 401
 *   3. POST recognition, invalid body              → 400
 *   4. POST recognition, valid                     → 204
 *   5. Idempotency: same recognition twice         → still one row
 *   6. GET profile aggregates apps across recognitions
 *   7. GET profile, unknown user                   → 404
 *   8. GET profile, missing Bearer                 → 401
 *   9. Email normalized (trim + lowercase) by the use-case
 *
 * The router is exercised through a fake in-memory repository, so no DB is
 * touched — the CA port makes the edge trivially testable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { makeJexIdentityRouter } from '../jex-identity.js'
import type {
    CanonicalProfile,
    JexRecognitionRepository,
    RecognitionInput,
} from '../../application/jex/ports.js'

const SERVICE_KEY = 'test-mesh-service-key-1234567890'
const USER_A = '11111111-1111-1111-1111-111111111111'
const USER_UNKNOWN = '99999999-9999-9999-9999-999999999999'

interface FakeRepo extends JexRecognitionRepository {
    rows: (RecognitionInput & { seenAt: number })[]
}

function makeFakeRepo(): FakeRepo {
    const rows: (RecognitionInput & { seenAt: number })[] = []
    let clock = 0
    return {
        rows,
        async record(input: RecognitionInput): Promise<void> {
            const existing = rows.find(
                (r) => r.appId === input.appId && r.userId === input.userId && r.credentialId === input.credentialId,
            )
            if (existing) {
                existing.email = input.email
                existing.seenAt = ++clock
            } else {
                rows.push({ ...input, seenAt: ++clock })
            }
        },
        async getProfile(userId: string): Promise<CanonicalProfile | null> {
            const recs = rows.filter((r) => r.userId === userId).sort((a, b) => b.seenAt - a.seenAt)
            if (recs.length === 0) return null
            return {
                userId,
                email: recs[0]!.email,
                name: 'Test User',
                apps: [...new Set(recs.map((r) => r.appId))],
            }
        },
    }
}

let server: Server | null = null
let baseUrl = ''
let repo: FakeRepo

beforeAll(async () => {
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
    repo = makeFakeRepo()
    const app = express()
    app.use(express.json())
    app.use('/api/jex', makeJexIdentityRouter(repo))
    const created = app.listen(0)
    server = created
    await new Promise<void>((r) => created.once('listening', () => r()))
    baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
})

afterAll(() => {
    server?.close()
})

const validBody = (over: Partial<RecognitionInput> = {}): RecognitionInput => ({
    appId: 'nexalog',
    userId: USER_A,
    email: 'dustin@example.com',
    credentialId: 'cred-abc',
    ...over,
})

function post(body: unknown, auth?: string) {
    return fetch(`${baseUrl}/api/jex/identity/recognition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify(body),
    })
}

function getProfile(userId: string, auth?: string) {
    return fetch(`${baseUrl}/api/jex/identity/profile/${userId}`, {
        headers: auth ? { Authorization: auth } : {},
    })
}

describe('POST /api/jex/identity/recognition', () => {
    it('401 without Bearer', async () => {
        expect((await post(validBody())).status).toBe(401)
    })

    it('401 with wrong Bearer', async () => {
        expect((await post(validBody(), 'Bearer nope')).status).toBe(401)
    })

    it('400 on invalid body', async () => {
        expect((await post({ appId: 'nexalog' }, `Bearer ${SERVICE_KEY}`)).status).toBe(400)
    })

    it('204 on valid recognition', async () => {
        expect((await post(validBody(), `Bearer ${SERVICE_KEY}`)).status).toBe(204)
    })

    it('is idempotent — same recognition twice keeps one row', async () => {
        const before = repo.rows.filter((r) => r.credentialId === 'cred-idem').length
        await post(validBody({ credentialId: 'cred-idem' }), `Bearer ${SERVICE_KEY}`)
        await post(validBody({ credentialId: 'cred-idem' }), `Bearer ${SERVICE_KEY}`)
        const after = repo.rows.filter((r) => r.credentialId === 'cred-idem').length
        expect(after - before).toBe(1)
    })

    it('normalizes email to lowercase for canonical aggregation', async () => {
        const res = await post(validBody({ credentialId: 'cred-email', email: 'MixedCase@Example.COM' }), `Bearer ${SERVICE_KEY}`)
        expect(res.status).toBe(204)
        const row = repo.rows.find((r) => r.credentialId === 'cred-email')
        expect(row?.email).toBe('mixedcase@example.com')
    })
})

describe('GET /api/jex/identity/profile/:userId', () => {
    it('401 without Bearer', async () => {
        expect((await getProfile(USER_A)).status).toBe(401)
    })

    it('404 for unknown user', async () => {
        expect((await getProfile(USER_UNKNOWN, `Bearer ${SERVICE_KEY}`)).status).toBe(404)
    })

    it('aggregates apps across recognitions', async () => {
        await post(validBody({ appId: 'nexalog', credentialId: 'c1' }), `Bearer ${SERVICE_KEY}`)
        await post(validBody({ appId: 'fylo', credentialId: 'c2' }), `Bearer ${SERVICE_KEY}`)
        const res = await getProfile(USER_A, `Bearer ${SERVICE_KEY}`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as CanonicalProfile
        expect(body.userId).toBe(USER_A)
        expect([...body.apps].sort()).toContain('nexalog')
        expect([...body.apps].sort()).toContain('fylo')
    })
})
