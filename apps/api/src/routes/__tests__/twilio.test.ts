// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Twilio inbound route tests.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createHmac } from 'node:crypto'

const AUTH_TOKEN = 'twilio-auth-token-xyz'
const WORKSPACE_ID = 'ws-twilio-1'
const CHANNEL_ID = 'channel-twilio-1'
const MISSING_CHANNEL_ID = 'channel-missing'
const DISABLED_CHANNEL_ID = 'channel-disabled'
const NO_TOKEN_CHANNEL_ID = 'channel-no-token'

// ── Test state ─────────────────────────────────────────────────────────────

const ctl = {
    pushResult: 'task-twilio-abc',
    pushThrows: false,
    lastPushArgs: null as Record<string, unknown> | null,
    lastRecordArgs: null as Record<string, unknown> | null,
}

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => {
    const channelRows: Record<string, { id: string; workspaceId: string; type: string; config: Record<string, unknown>; enabled: boolean }> = {
        [CHANNEL_ID]: {
            id: CHANNEL_ID,
            workspaceId: WORKSPACE_ID,
            type: 'twilio',
            config: { accountSid: 'AC' + 'a'.repeat(32), authToken: AUTH_TOKEN, fromNumber: '+15557654321' },
            enabled: true,
        },
        [DISABLED_CHANNEL_ID]: {
            id: DISABLED_CHANNEL_ID,
            workspaceId: WORKSPACE_ID,
            type: 'twilio',
            config: { accountSid: 'AC' + 'a'.repeat(32), authToken: AUTH_TOKEN, fromNumber: '+15557654321' },
            enabled: false,
        },
        [NO_TOKEN_CHANNEL_ID]: {
            id: NO_TOKEN_CHANNEL_ID,
            workspaceId: WORKSPACE_ID,
            type: 'twilio',
            config: { accountSid: 'AC' + 'a'.repeat(32), fromNumber: '+15557654321' },
            enabled: true,
        },
    }
    let pendingId: string | null = null
    return {
        db: {
            select(_fields?: unknown) {
                return {
                    from(_t: unknown) { return this },
                    where(c: { _id?: string }) {
                        pendingId = c?._id ?? null
                        return this
                    },
                    async limit(_n: number) {
                        if (!pendingId) return []
                        const row = channelRows[pendingId]
                        return row ? [row] : []
                    },
                }
            },
        },
        eq: (_col: unknown, val: string) => ({ _id: val }),
        channels: { id: 'channels.id' },
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


vi.mock('@plexo/queue', () => ({
    push: vi.fn(async (args: Record<string, unknown>) => {
        ctl.lastPushArgs = args
        if (ctl.pushThrows) throw new Error('Queue unavailable')
        return ctl.pushResult
    }),
}))

vi.mock('../../conversation-log.js', () => ({
    recordConversation: vi.fn(async (args: Record<string, unknown>) => {
        ctl.lastRecordArgs = args
        return 'conv-id'
    }),
}))

vi.mock('../../lib/session-resolver.js', () => ({
    resolveSessionId: vi.fn(async () => ({
        sessionId: 'session-twilio-fixed',
        newMessageEmbedding: null,
        isNewSession: true,
        reason: 'test',
    })),
}))

vi.mock('../../event-tracker.js', () => ({
    trackEvent: vi.fn(),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// _resetTwilioDedupForTests probes redis-client, which tries to connect to
// localhost:6379 in this test env (no Redis available) — would hang the
// hook. Mock it to report unavailable so the helper falls back to clearing
// the in-memory dedup set only.
vi.mock('../../redis-client.js', () => ({
    isRedisAvailable: vi.fn(() => false),
    getRedis: vi.fn(async () => { throw new Error('redis disabled in tests') }),
    markRedisDown: vi.fn(),
}))

// ── Server bootstrap ───────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function getServer(): Promise<string> {
    if (!server) {
        const { twilioRouter } = await import('../twilio.js')
        const app = express()
        app.use(express.urlencoded({ extended: false }))
        app.use('/api/v1/channels/twilio', twilioRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>(r => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildSignedRequest(channelId: string, params: Record<string, string>, token = AUTH_TOKEN): { url: string; body: string; signature: string } {
    const sortedKeys = Object.keys(params).sort()
    const path = `/api/v1/channels/twilio/events/${channelId}`
    return buildSignedRequestPath(path, params, token)

    function buildSignedRequestPath(p: string, ps: Record<string, string>, t: string) {
        const _ = sortedKeys
        const fullUrl = `${baseUrl}${p}`
        let data = fullUrl
        for (const k of Object.keys(ps).sort()) data += k + ps[k]
        const sig = createHmac('sha1', t).update(data).digest('base64')
        const body = new URLSearchParams(ps).toString()
        return { url: fullUrl, body, signature: sig }
    }
}

beforeEach(async () => {
    ctl.pushResult = 'task-twilio-abc'
    ctl.pushThrows = false
    ctl.lastPushArgs = null
    ctl.lastRecordArgs = null
    vi.clearAllMocks()
    // Reset dedup map between tests
    const mod = await import('../twilio.js')
    await mod._resetTwilioDedupForTests()
})

afterAll(() => { server?.close() })

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/channels/twilio/events/:channelId', () => {
    it('valid signed POST creates conversation + pushes task', async () => {
        await getServer()
        const params = {
            From: '+15551234567',
            To: '+15557654321',
            Body: 'hello plexo',
            MessageSid: 'SM' + '1'.repeat(32),
            AccountSid: 'AC' + 'a'.repeat(32),
        }
        const { url, body, signature } = buildSignedRequest(CHANNEL_ID, params)
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
            body,
        })
        expect(res.status).toBe(200)
        expect(ctl.lastPushArgs).toBeTruthy()
        expect(ctl.lastPushArgs).toMatchObject({
            workspaceId: WORKSPACE_ID,
            source: 'twilio',
            type: 'automation',
        })
        expect(ctl.lastRecordArgs).toMatchObject({
            workspaceId: WORKSPACE_ID,
            source: 'twilio',
            taskId: ctl.pushResult,
        })
    })

    it('returns 401 on wrong signature', async () => {
        await getServer()
        const params = {
            From: '+15551234567',
            To: '+15557654321',
            Body: 'unauthorized',
            MessageSid: 'SM' + '2'.repeat(32),
            AccountSid: 'AC' + 'a'.repeat(32),
        }
        const wrong = createHmac('sha1', 'wrong-token').update('garbage').digest('base64')
        const body = new URLSearchParams(params).toString()
        const res = await fetch(`${baseUrl}/api/v1/channels/twilio/events/${CHANNEL_ID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': wrong },
            body,
        })
        expect(res.status).toBe(401)
    })

    it('returns 404 when channel does not exist', async () => {
        await getServer()
        const params = {
            From: '+15551234567',
            To: '+15557654321',
            Body: 'who?',
            MessageSid: 'SM' + '3'.repeat(32),
            AccountSid: 'AC' + 'a'.repeat(32),
        }
        const { url, body, signature } = buildSignedRequest(MISSING_CHANNEL_ID, params)
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
            body,
        })
        expect(res.status).toBe(404)
    })

    it('returns 410 when channel is disabled', async () => {
        await getServer()
        const params = {
            From: '+15551234567',
            To: '+15557654321',
            Body: 'disabled',
            MessageSid: 'SM' + '4'.repeat(32),
            AccountSid: 'AC' + 'a'.repeat(32),
        }
        const { url, body, signature } = buildSignedRequest(DISABLED_CHANNEL_ID, params)
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
            body,
        })
        expect(res.status).toBe(410)
    })

    it('replay (same MessageSid) returns 200 with no second push', async () => {
        await getServer()
        const params = {
            From: '+15551234567',
            To: '+15557654321',
            Body: 'replay test',
            MessageSid: 'SM' + '5'.repeat(32),
            AccountSid: 'AC' + 'a'.repeat(32),
        }
        const { url, body, signature } = buildSignedRequest(CHANNEL_ID, params)
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }
        const r1 = await fetch(url, { method: 'POST', headers, body })
        expect(r1.status).toBe(200)
        const firstPush = ctl.lastPushArgs
        ctl.lastPushArgs = null
        const r2 = await fetch(url, { method: 'POST', headers, body })
        expect(r2.status).toBe(200)
        expect(ctl.lastPushArgs).toBeNull()
        expect(firstPush).toBeTruthy()
    })

    it('returns 400 on malformed body (no MessageSid)', async () => {
        await getServer()
        const params = { Body: 'no sid here', From: '+1', To: '+2' }
        const { url, body, signature } = buildSignedRequest(CHANNEL_ID, params)
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
            body,
        })
        expect(res.status).toBe(400)
    })

    it('returns 500 with structured error when channel.config has no authToken', async () => {
        await getServer()
        const params = {
            From: '+15551234567',
            To: '+15557654321',
            Body: 'no token',
            MessageSid: 'SM' + '6'.repeat(32),
            AccountSid: 'AC' + 'a'.repeat(32),
        }
        // Sign with anything — the route should reject before signature check
        // since authToken is missing in the channel config.
        const body = new URLSearchParams(params).toString()
        const res = await fetch(`${baseUrl}/api/v1/channels/twilio/events/${NO_TOKEN_CHANNEL_ID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'anything' },
            body,
        })
        expect(res.status).toBe(500)
        const json = await res.json() as { error: { code: string } }
        expect(json.error.code).toBe('CHANNEL_MISCONFIGURED')
    })

    it('queue push payload includes channelRef shape from D4', async () => {
        await getServer()
        const params = {
            From: '+15551234567',
            To: '+15557654321',
            Body: 'check channelRef',
            MessageSid: 'SM' + '7'.repeat(32),
            AccountSid: 'AC' + 'a'.repeat(32),
        }
        const { url, body, signature } = buildSignedRequest(CHANNEL_ID, params)
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
            body,
        })
        const ctx = (ctl.lastPushArgs as { context?: Record<string, unknown> })?.context
        expect(ctx).toBeTruthy()
        expect(ctx).toMatchObject({
            channel: 'twilio',
            channelId: CHANNEL_ID,
            from: '+15551234567',
            messageSid: 'SM' + '7'.repeat(32),
        })
        expect(ctx?.channelRef).toMatchObject({
            channel: 'twilio',
            channelId: CHANNEL_ID,
            chatId: '+15551234567',
        })
    })
})
