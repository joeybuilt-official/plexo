// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase L3 Stage 2 — outbound Gmail reply delivery.
 *
 * Two layers under test:
 *   1. deliverToGmail in channel-delivery.ts — wires synthetic context onto
 *      gmailSend with the right subject (Re: ...), threadId, and In-Reply-To.
 *   2. gmailSend in @plexo/agent/channels/gmail-send — the fetch primitive:
 *      builds RFC 2822 message, posts to Gmail API, retries on 401, errors
 *      on missing installed_connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks (must come before importing the modules under test) ───────────────

vi.mock('../channel-ai.js', () => ({
    translateErrorForUser: (msg: string) => `error: ${msg}`,
}))

vi.mock('../logger.js', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}))

// Mock @plexo/db at the @plexo/agent dynamic-import boundary used by gmail-send.
const dbState: {
    channel: { workspaceId: string; type: string; enabled: boolean; config: Record<string, unknown> } | null
    installedConnection: { id: string; credentials: { encrypted?: string } } | null
} = {
    channel: null,
    installedConnection: null,
}

vi.mock('@plexo/db', () => {
    // Track whether the most recent .from() targets channels or installedConnections
    // so the same fluent builder serves both queries inside gmail-send.
    const fluent = () => {
        let target: 'channel' | 'connection' | null = null
        const chain: Record<string, unknown> = {
            from: (table: { __kind?: string }) => {
                target = table?.__kind === 'connection' ? 'connection' : 'channel'
                return chain
            },
            where: () => chain,
            limit: () => Promise.resolve(
                target === 'connection'
                    ? (dbState.installedConnection ? [dbState.installedConnection] : [])
                    : (dbState.channel ? [dbState.channel] : []),
            ),
            orderBy: () => chain,
        }
        return chain
    }
    return {
        db: {
            select: vi.fn(() => fluent()),
            update: vi.fn(() => ({
                set: () => ({ where: () => Promise.resolve() }),
            })),
        },
        eq: vi.fn(),
        and: vi.fn(),
        channels: { __kind: 'channel', id: 'id', workspaceId: 'workspaceId', type: 'type', enabled: 'enabled', config: 'config' },
        installedConnections: { __kind: 'connection', id: 'id', credentials: 'credentials', lastVerifiedAt: 'lastVerifiedAt' },
    }
})

// Decrypt path: use real encrypt/decrypt with a deterministic ENCRYPTION_SECRET
// set below. No mock needed.

// ── Test fixtures ────────────────────────────────────────────────────────────

const FAKE_CHANNEL_ID = 'channel-123'
const FAKE_INSTALLED_CONN_ID = 'ic-456'
const FAKE_TO = 'user@example.com'
const FAKE_FROM_EMAIL = 'bot@plexo-test.com'
const FAKE_ACCESS_TOKEN = 'access_TOKEN_xyz'
const FAKE_REFRESH_TOKEN = 'refresh_TOKEN_xyz'
const FAKE_THREAD_ID = 'thread-abc'
const FAKE_MESSAGE_ID = '<original@mail.example.com>'

async function setUpHappyPath() {
    const { encrypt } = await import('@plexo/agent/connections/crypto-util')
    dbState.channel = {
        workspaceId: 'ws-1',
        type: 'gmail',
        enabled: true,
        config: { installedConnectionId: FAKE_INSTALLED_CONN_ID, emailAddress: FAKE_FROM_EMAIL },
    }
    dbState.installedConnection = {
        id: FAKE_INSTALLED_CONN_ID,
        credentials: {
            encrypted: encrypt(
                JSON.stringify({
                    access_token: FAKE_ACCESS_TOKEN,
                    refresh_token: FAKE_REFRESH_TOKEN,
                    expires_at: new Date(Date.now() + 3600_000).toISOString(),
                    email: FAKE_FROM_EMAIL,
                }),
                'ws-1',
            ),
        },
    }
}

function decodeBase64Url(s: string): string {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)
    return Buffer.from(padded, 'base64').toString('utf8')
}

beforeEach(() => {
    dbState.channel = null
    dbState.installedConnection = null
    process.env.GOOGLE_CLIENT_ID = 'cid'
    process.env.GOOGLE_CLIENT_SECRET = 'csec'
    process.env.ENCRYPTION_SECRET = 'test-secret-deterministic-32bytes!'
})

afterEach(() => {
    vi.restoreAllMocks()
})

// ── deliverToGmail (channel-delivery wiring) ─────────────────────────────────

describe('deliverToGmail', () => {
    it('sends an in-thread reply with Re: subject and decoded body containing summary', async () => {
        await setUpHappyPath()

        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ id: 'gmail-msg-1', threadId: FAKE_THREAD_ID }), { status: 200 }),
        )

        const { deliverToGmail } = await import('../channel-delivery.js')

        await deliverToGmail(
            {
                channel: 'gmail',
                channelId: FAKE_CHANNEL_ID,
                from: FAKE_TO,
                chatId: FAKE_TO,
                subject: 'Quarterly report draft',
                threadId: FAKE_THREAD_ID,
                messageId: FAKE_MESSAGE_ID,
            },
            'Done — drafted Q3 numbers and pushed to the shared doc.',
            undefined,
            'complete',
        )

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]!
        expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
        const headers = (init as RequestInit).headers as Record<string, string>
        expect(headers.Authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`)

        const reqBody = JSON.parse((init as RequestInit).body as string) as { raw: string; threadId?: string }
        expect(reqBody.threadId).toBe(FAKE_THREAD_ID)
        const decoded = decodeBase64Url(reqBody.raw)
        expect(decoded).toContain('Subject: Re: Quarterly report draft')
        expect(decoded).toContain(`In-Reply-To: ${FAKE_MESSAGE_ID}`)
        expect(decoded).toContain(`References: ${FAKE_MESSAGE_ID}`)
        expect(decoded).toContain(`To: ${FAKE_TO}`)
        expect(decoded).toContain(`From: ${FAKE_FROM_EMAIL}`)
        expect(decoded).toContain('Done — drafted Q3 numbers')
    })

    it('falls back to "Re: Plexo task complete" when context.subject is missing', async () => {
        await setUpHappyPath()
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ id: 'm', threadId: 't' }), { status: 200 }),
        )
        const { deliverToGmail } = await import('../channel-delivery.js')
        await deliverToGmail(
            { channel: 'gmail', channelId: FAKE_CHANNEL_ID, from: FAKE_TO, chatId: FAKE_TO },
            'short summary',
            undefined,
            'complete',
        )
        const reqBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { raw: string }
        expect(decodeBase64Url(reqBody.raw)).toContain('Subject: Re: Plexo task complete')
    })
})

// ── gmailSend primitive (fetch + 401 retry + missing connection) ─────────────

describe('gmailSend', () => {
    it('retries once on 401 after refreshing the access token', async () => {
        await setUpHappyPath()

        let call = 0
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            call += 1
            const url = String(input)
            if (url === 'https://oauth2.googleapis.com/token') {
                return new Response(JSON.stringify({ access_token: 'new_AT', expires_in: 3600 }), { status: 200 })
            }
            // First send 401, second send 200.
            if (call === 1) return new Response(JSON.stringify({ error: { message: 'auth' } }), { status: 401 })
            return new Response(JSON.stringify({ id: 'm2', threadId: FAKE_THREAD_ID }), { status: 200 })
        })

        const { gmailSend } = await import('@plexo/agent/channels/gmail-send')
        const result = await gmailSend({
            channelId: FAKE_CHANNEL_ID,
            to: FAKE_TO,
            subject: 'Re: hello',
            body: 'second-try body',
            threadId: FAKE_THREAD_ID,
            inReplyTo: FAKE_MESSAGE_ID,
        })

        expect(result.ok).toBe(true)
        expect(result.messageId).toBe('m2')

        const sendCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/messages/send'))
        expect(sendCalls.length).toBe(2)
        const finalAuth = (sendCalls[1]![1] as RequestInit).headers as Record<string, string>
        expect(finalAuth.Authorization).toBe('Bearer new_AT')
    })

    it('throws a clear error when the channel has no installedConnection', async () => {
        dbState.channel = {
            workspaceId: 'ws-1',
            type: 'gmail',
            enabled: true,
            config: {}, // no installedConnectionId
        }
        dbState.installedConnection = null

        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))

        const { deliverToGmail } = await import('../channel-delivery.js')
        await expect(
            deliverToGmail(
                { channel: 'gmail', channelId: FAKE_CHANNEL_ID, from: FAKE_TO, chatId: FAKE_TO, subject: 'Hi' },
                'summary',
                undefined,
                'complete',
            ),
        ).rejects.toThrow(/Gmail delivery failed|connection unavailable/i)
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
