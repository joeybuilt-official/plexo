// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Sync gmessages tool-invoke routes — Levio↔gmessages bridge (SDK 1.2.0).
 * Exercises auth, payload validation, missing-connection, missing-session,
 * sidecar dispatch failure, happy path, phoneE164 resolution.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Hoisted mocks must precede the router import.
const mockSelectImpl = vi.fn()
const mockInsertImpl = vi.fn()
const mockSidecarSend = vi.fn()

vi.mock('@plexo/db', () => ({
    db: {
        select: (...args: unknown[]) => mockSelectImpl(...args),
        insert: (...args: unknown[]) => mockInsertImpl(...args),
    },
    installedConnections: {},
    channels: {
        id: 'channels.id',
        type: 'channels.type',
        workspaceId: 'channels.workspaceId',
    },
    pairedSessions: {
        id: 'pairedSessions.id',
        channelId: 'pairedSessions.channelId',
        workspaceId: 'pairedSessions.workspaceId',
        state: 'pairedSessions.state',
        stateChangedAt: 'pairedSessions.stateChangedAt',
    },
    conversations: {
        id: 'conversations.id',
        workspaceId: 'conversations.workspaceId',
        sessionId: 'conversations.sessionId',
        source: 'conversations.source',
        message: 'conversations.message',
        reply: 'conversations.reply',
        status: 'conversations.status',
        intent: 'conversations.intent',
        channelRef: 'conversations.channelRef',
        attachments: 'conversations.attachments',
        createdAt: 'conversations.createdAt',
    },
    eq: vi.fn((a, b) => ({ _eq: [a, b] })),
    and: vi.fn((...xs) => ({ _and: xs })),
    desc: vi.fn((x) => ({ _desc: x })),
    inArray: vi.fn((a, b) => ({ _inArray: [a, b] })),
    sql: Object.assign(vi.fn(() => ({ _sql: true })), { raw: vi.fn() }),
}))

vi.mock('../lib/gmessages-sidecar.js', () => ({
    sidecarSessionSend: (...args: unknown[]) => mockSidecarSend(...args),
    sidecarPairStart: vi.fn(),
    sidecarPairStatus: vi.fn(),
    sidecarPairDiscard: vi.fn(),
    sidecarSessionRefresh: vi.fn(),
}))

vi.mock('../logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { toolsGmessagesRouter } from './tools-gmessages.js'

const SERVICE_KEY = 'test-service-key-1234567890abcd'
const WS = '00000000-0000-4000-8000-000000000001'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333'
const THREAD = 'gthread-abc'

let server: Server | null = null
let baseUrl = ''

async function getServer(): Promise<string> {
    if (!server) {
        const app = express()
        app.use(express.json())
        app.use('/api/v1/tools/gmessages', toolsGmessagesRouter)
        const created = app.listen(0)
        server = created
        await new Promise<void>(r => created.once('listening', () => r()))
        baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
    }
    return baseUrl
}

afterAll(() => { server?.close() })

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_KEY}`,
        'X-App-Id': 'levio',
        ...extra,
    }
}

interface ChainStep {
    rows?: Array<Record<string, unknown>>
}

/**
 * Chains: select().from().[innerJoin().]where().orderBy().limit() OR
 *         select().from().where().orderBy().limit() OR
 *         select().from().where() (no orderBy/limit).
 * The chain is recursive on itself so any subset of the above resolves.
 */
function mockSelectQueue(steps: ChainStep[]) {
    let i = 0
    mockSelectImpl.mockImplementation(() => {
        const step = steps[i++] ?? { rows: [] }
        const rows = step.rows ?? []
        const chain: any = {
            from: () => chain,
            innerJoin: () => chain,
            where: () => chain,
            orderBy: () => chain,
            limit: async () => rows,
            then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
        }
        return chain
    })
}

function mockInsertSuccess() {
    mockInsertImpl.mockImplementation(() => ({
        values: async () => undefined,
    }))
}

beforeEach(() => {
    process.env.PLEXO_SERVICE_KEY = SERVICE_KEY
    vi.clearAllMocks()
    mockInsertSuccess()
})

describe('POST /api/v1/tools/gmessages/send', () => {
    it('happy path — returns messageId on sidecar success', async () => {
        mockSelectQueue([
            { rows: [{ sessionId: SESSION_ID, channelId: CHANNEL_ID }] },
        ])
        mockSidecarSend.mockResolvedValueOnce({ accepted: true, messageId: 'libgm-msg-123' })

        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/send`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: WS, threadId: THREAD, text: 'hi from levio' }),
        })
        const body = await res.json() as { messageId: string; deliveryStatus: string }
        expect([200, 202]).toContain(res.status)
        expect(typeof body.messageId).toBe('string')
        expect(mockSidecarSend).toHaveBeenCalledWith(SESSION_ID, THREAD, 'hi from levio', expect.any(String))
    })

    it('returns 409 when no live paired session exists for workspace', async () => {
        mockSelectQueue([{ rows: [] }])
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/send`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: WS, threadId: THREAD, text: 'hi' }),
        })
        expect(res.status).toBe(409)
    })

    it('returns 400 on missing workspaceId', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/send`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ threadId: THREAD, text: 'hi' }),
        })
        expect(res.status).toBe(400)
    })

    it('returns 400 on empty text', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/send`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: WS, threadId: THREAD, text: '' }),
        })
        expect(res.status).toBe(400)
    })

    it('returns 400 when neither threadId nor phoneE164 provided', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/send`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: WS, text: 'hi' }),
        })
        expect(res.status).toBe(400)
    })

    it('returns 501 when phoneE164 cannot be resolved to a thread', async () => {
        mockSelectQueue([
            { rows: [{ sessionId: SESSION_ID, channelId: CHANNEL_ID }] },
            { rows: [] }, // recent conversations rows for phone lookup — empty
        ])
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/send`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: WS, phoneE164: '+15551234567', text: 'hi' }),
        })
        expect(res.status).toBe(501)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('PHONE_LOOKUP_NOT_IMPLEMENTED')
    })

    it('returns 401 without service-key auth', async () => {
        const headers = authHeaders()
        delete headers.Authorization
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/send`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ workspaceId: WS, threadId: THREAD, text: 'hi' }),
        })
        expect(res.status).toBe(401)
    })

    it('returns 502 when sidecar dispatch throws', async () => {
        mockSelectQueue([
            { rows: [{ sessionId: SESSION_ID, channelId: CHANNEL_ID }] },
        ])
        mockSidecarSend.mockRejectedValueOnce(new Error('connection refused'))
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/send`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ workspaceId: WS, threadId: THREAD, text: 'hi' }),
        })
        expect(res.status).toBe(502)
    })
})

describe('GET /api/v1/tools/gmessages/threads', () => {
    it('returns 400 on missing workspaceId', async () => {
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/threads`, {
            method: 'GET',
            headers: authHeaders(),
        })
        expect(res.status).toBe(400)
    })

    it('returns 401 without service-key auth', async () => {
        const headers = authHeaders()
        delete headers.Authorization
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/threads?workspaceId=${WS}`, {
            method: 'GET',
            headers,
        })
        expect(res.status).toBe(401)
    })

    it('returns empty threads when no gmessages channels exist', async () => {
        mockSelectQueue([{ rows: [] }])
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/threads?workspaceId=${WS}`, {
            method: 'GET',
            headers: authHeaders(),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { threads: unknown[] }
        expect(body.threads).toEqual([])
    })

    it('folds conversations into thread summaries', async () => {
        const baseTime = new Date('2026-05-12T10:00:00Z')
        mockSelectQueue([
            { rows: [{ id: CHANNEL_ID }] },
            {
                rows: [
                    {
                        sessionId: `gmessages:${THREAD}`,
                        message: '',
                        reply: 'outbound reply',
                        createdAt: baseTime,
                        channelRef: { channel: 'gmessages', channelId: CHANNEL_ID, chatId: THREAD },
                        attachments: [],
                    },
                ],
            },
        ])
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/threads?workspaceId=${WS}`, {
            method: 'GET',
            headers: authHeaders(),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as {
            threads: Array<{
                threadId: string
                participants: unknown[]
                lastMessage: { text: string; direction: string; sentAt: string }
                unreadCount: number
            }>
        }
        expect(body.threads).toHaveLength(1)
        expect(body.threads[0]!.threadId).toBe(THREAD)
        expect(body.threads[0]!.lastMessage.direction).toBe('outbound')
        expect(body.threads[0]!.lastMessage.text).toBe('outbound reply')
        expect(body.threads[0]!.unreadCount).toBe(0)
    })

    it('clamps limit to [1, 100]', async () => {
        mockSelectQueue([
            { rows: [{ id: CHANNEL_ID }] },
            { rows: [] },
        ])
        const base = await getServer()
        const res = await fetch(`${base}/api/v1/tools/gmessages/threads?workspaceId=${WS}&limit=9999`, {
            method: 'GET',
            headers: authHeaders(),
        })
        expect(res.status).toBe(200)
    })
})
