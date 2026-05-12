// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @plexo/db before importing the factory so the dynamic import resolves
// to our mock. The factory uses await import('@plexo/db') inside execute() so
// each tool invocation re-resolves through the cache.
const dbInsertSpy = vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) }))
const dbSelectChain = (rows: unknown[]) => ({
    from: () => ({
        where: () => ({
            orderBy: () => ({ limit: vi.fn().mockResolvedValue(rows) }),
        }),
    }),
})

let pairedSessionsRows: unknown[] = []
let conversationsRows: unknown[] = []

vi.mock('@plexo/db', () => ({
    db: {
        select: vi.fn((shape: unknown) => {
            // Distinguish paired_sessions vs conversations queries by which
            // table the caller selects from. Easier: alternate based on which
            // call this is — first is always paired-session lookup, second is
            // conversations (in list_threads). We track a counter.
            void shape
            const isFirst = selectCount === 0
            selectCount += 1
            return dbSelectChain(isFirst ? pairedSessionsRows : conversationsRows)
        }),
        insert: dbInsertSpy,
    },
    eq: vi.fn(),
    and: vi.fn(),
    inArray: vi.fn(),
    desc: vi.fn(),
    sql: Object.assign(
        (...args: unknown[]) => args.join(''),
        { raw: (s: string) => s },
    ),
    pairedSessions: {
        id: 'id',
        channelId: 'channelId',
        state: 'state',
        workspaceId: 'workspaceId',
        installedConnectionId: 'installedConnectionId',
        stateChangedAt: 'stateChangedAt',
    },
    conversations: {
        id: 'id',
        workspaceId: 'workspaceId',
        sessionId: 'sessionId',
        source: 'source',
        message: 'message',
        reply: 'reply',
        createdAt: 'createdAt',
        channelRef: 'channelRef',
    },
}))

let selectCount = 0
const fetchSpy = vi.fn()

beforeEach(() => {
    selectCount = 0
    pairedSessionsRows = []
    conversationsRows = []
    dbInsertSpy.mockClear()
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    process.env.PLEXO_SERVICE_KEY = 'test-secret'
    process.env.GMESSAGES_SIDECAR_URL = 'http://sidecar:3010'
})

const { GMESSAGES_TOOLS } = await import('./gmessages.js')

const opts = { connectionId: 'conn-1', workspaceId: 'ws-1' }

describe('Google Messages Tool Factory', () => {
    it('produces both seed-advertised tools', () => {
        const tools = GMESSAGES_TOOLS({}, opts)
        expect(Object.keys(tools).sort()).toEqual(['gmessages__list_threads', 'gmessages__send_message'])
    })

    it('send_message returns no-session error when no paired session is live', async () => {
        pairedSessionsRows = []
        const tools = GMESSAGES_TOOLS({}, opts)
        const result = await tools.gmessages__send_message.execute({ threadId: 't1', text: 'hi' })
        expect(result).toContain('no live paired session')
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('send_message dispatches via sidecar with HMAC headers when session is live', async () => {
        pairedSessionsRows = [{ id: 'paired-1', channelId: 'chan-1', state: 'active' }]
        fetchSpy.mockResolvedValue({
            ok: true,
            status: 202,
            json: async () => ({ accepted: true, messageId: 'libgm-tmp-9' }),
            text: async () => '',
        })

        const tools = GMESSAGES_TOOLS({}, opts)
        const result = await tools.gmessages__send_message.execute({ threadId: 'thr-7', text: 'hello' })

        expect(fetchSpy).toHaveBeenCalledTimes(1)
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('http://sidecar:3010/sessions/paired-1/send')
        expect(init.method).toBe('POST')
        const headers = init.headers as Record<string, string>
        expect(headers['X-App-Id']).toBe('plexo-api')
        expect(headers['X-Plexo-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
        expect(headers['X-Plexo-Timestamp']).toBeDefined()
        expect(JSON.parse(init.body as string)).toMatchObject({ threadId: 'thr-7', text: 'hello' })
        expect(result).toContain('thr-7')
        expect(result).toContain('libgm-tmp-9')
        expect(dbInsertSpy).toHaveBeenCalledTimes(1)
    })

    it('send_message returns sidecar error message when sidecar 5xxs', async () => {
        pairedSessionsRows = [{ id: 'paired-1', channelId: 'chan-1', state: 'active' }]
        fetchSpy.mockResolvedValue({
            ok: false,
            status: 503,
            json: async () => ({}),
            text: async () => 'sidecar down',
        })

        const tools = GMESSAGES_TOOLS({}, opts)
        const result = await tools.gmessages__send_message.execute({ threadId: 'thr-7', text: 'hello' })
        expect(result).toContain('Google Messages send failed')
        expect(result).toContain('503')
    })

    it('list_threads returns empty-state message when no rows', async () => {
        pairedSessionsRows = [{ id: 'paired-1', channelId: 'chan-1', state: 'active' }]
        conversationsRows = []
        const tools = GMESSAGES_TOOLS({}, opts)
        const result = await tools.gmessages__list_threads.execute({ limit: 10 })
        expect(result).toContain('No Google Messages threads')
    })

    it('list_threads folds rows into one entry per sessionId, most-recent first', async () => {
        pairedSessionsRows = [{ id: 'paired-1', channelId: 'chan-1', state: 'active' }]
        const now = new Date('2026-05-12T00:00:00Z')
        const earlier = new Date('2026-05-11T00:00:00Z')
        conversationsRows = [
            { sessionId: 'gmessages:thr-A', message: 'newest in A', reply: '', createdAt: now, channelRef: { chatId: 'thr-A' } },
            { sessionId: 'gmessages:thr-A', message: 'older in A', reply: '', createdAt: earlier, channelRef: { chatId: 'thr-A' } },
            { sessionId: 'gmessages:thr-B', message: 'only in B', reply: '', createdAt: earlier, channelRef: { chatId: 'thr-B' } },
        ]
        const tools = GMESSAGES_TOOLS({}, opts)
        const result = (await tools.gmessages__list_threads.execute({ limit: 10 })) as string
        expect(result).toContain('thr-A')
        expect(result).toContain('newest in A')
        expect(result).toContain('thr-B')
        // Older row in A folded out
        expect(result).not.toContain('older in A')
    })
})
