// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
    pollAllGmailChannels,
    extractBodyText,
    extractHeader,
    _resetGmailDedupForTests,
    type PollDeps,
    type RefreshResult,
} from '../gmail-poll.js'

// ── Test fixtures ────────────────────────────────────────────────────────────

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const CHANNEL_ID = 'channel-abc'
const CONNECTION_ID = 'conn-xyz'

function b64url(s: string): string {
    return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function mkMessage(opts: {
    id: string
    threadId?: string
    from?: string
    subject?: string
    body?: string
    bodyMime?: 'text/plain' | 'text/html'
}): unknown {
    const body = opts.body ?? 'hello from gmail'
    return {
        id: opts.id,
        threadId: opts.threadId ?? `thread-${opts.id}`,
        snippet: body.slice(0, 100),
        payload: {
            mimeType: 'multipart/alternative',
            headers: [
                { name: 'From', value: opts.from ?? 'sender@example.com' },
                { name: 'Subject', value: opts.subject ?? 'Test subject' },
                { name: 'To', value: 'me@plexo.test' },
            ],
            parts: [
                {
                    mimeType: opts.bodyMime ?? 'text/plain',
                    body: { data: b64url(body), size: body.length },
                },
            ],
        },
    }
}

function mkChannel(extras: Record<string, unknown> = {}): {
    id: string
    workspaceId: string
    enabled: boolean
    config: Record<string, unknown>
} {
    return {
        id: CHANNEL_ID,
        workspaceId: WORKSPACE_ID,
        enabled: true,
        config: {
            installedConnectionId: CONNECTION_ID,
            lastHistoryId: '100',
            ...extras,
        },
    }
}

interface CapturedDeps {
    persisted: Array<{ messageId: string; threadId: string; bodyText: string; subject: string; from: string }>
    historyIdsWritten: string[]
    refreshCalls: number
    erroredChannels: Array<{ id: string; message: string }>
    revokedConnections: Array<{ id: string; reason: string }>
    persistedCreds: Array<unknown>
    baselineCalls: number
    deps: PollDeps
}

function buildDeps(overrides: Partial<PollDeps> & {
    historyResponses?: Array<{ status: number; data?: unknown; error?: string }>
    messages?: Record<string, unknown>
    creds?: { access_token?: string; refresh_token?: string; expires_at?: string | null }
    refreshResult?: RefreshResult
    channels?: ReturnType<typeof mkChannel>[]
    baselineResult?: string | null
}): CapturedDeps {
    const captured: CapturedDeps = {
        persisted: [],
        historyIdsWritten: [],
        refreshCalls: 0,
        erroredChannels: [],
        revokedConnections: [],
        persistedCreds: [],
        baselineCalls: 0,
        deps: {} as PollDeps,
    }

    let historyCallIdx = 0
    const historyResponses = overrides.historyResponses ?? []
    const messages = overrides.messages ?? {}
    let currentCreds = overrides.creds ?? {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }

    captured.deps = {
        listGmailChannels: vi.fn(async () => overrides.channels ?? [mkChannel()]),
        loadConnection: vi.fn(async () => ({ ...currentCreds })),
        persistRefreshedCreds: vi.fn(async (_id, _ws, c) => {
            captured.persistedCreds.push(c)
            currentCreds = { ...currentCreds, ...(c as object) }
        }),
        markChannelErrored: vi.fn(async (id, message) => {
            captured.erroredChannels.push({ id, message })
        }),
        markConnectionRevoked: vi.fn(async (id, reason) => {
            captured.revokedConnections.push({ id, reason })
        }),
        fetchHistory: vi.fn(async (_t, _h, _pageToken?: string) => {
            const r = historyResponses[historyCallIdx] ?? { status: 200, data: { history: [], historyId: '100' } }
            historyCallIdx++
            return r as { status: number; data?: { historyId?: string; nextPageToken?: string }; error?: string }
        }),
        fetchMessage: vi.fn(async (_token, messageId) => {
            const m = messages[messageId]
            if (!m) return { status: 404, error: 'not found' }
            return { status: 200, data: m as never }
        }),
        refreshAccessToken: vi.fn(async (): Promise<RefreshResult> => {
            captured.refreshCalls++
            return overrides.refreshResult === undefined
                ? { kind: 'success', access_token: 'access-2', expires_at: new Date(Date.now() + 3600_000).toISOString() }
                : overrides.refreshResult
        }),
        baselineHistoryId: vi.fn(async () => {
            captured.baselineCalls++
            return overrides.baselineResult === undefined ? '100' : overrides.baselineResult
        }),
        updateLastHistoryId: vi.fn(async (_chanId, hid) => { captured.historyIdsWritten.push(hid) }),
        persistInbound: vi.fn(async (args) => {
            captured.persisted.push({
                messageId: args.messageId,
                threadId: args.threadId,
                bodyText: args.bodyText,
                subject: args.subject,
                from: args.from,
            })
        }),
        ...overrides,
    } as PollDeps

    return captured
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('gmail-poll', () => {
    beforeEach(() => {
        _resetGmailDedupForTests()
    })

    describe('extractBodyText', () => {
        it('prefers text/plain part', () => {
            const msg = mkMessage({ id: 'm1', body: 'plain body here' }) as never
            expect(extractBodyText(msg)).toBe('plain body here')
        })

        it('falls back to stripped HTML when only text/html is present', () => {
            const html = '<html><body>Hello <b>world</b>!</body></html>'
            const msg = mkMessage({ id: 'm1', body: html, bodyMime: 'text/html' }) as never
            const text = extractBodyText(msg)
            expect(text).toContain('Hello world')
            expect(text).not.toContain('<b>')
        })

        it('truncates body to 32KB', () => {
            const huge = 'x'.repeat(50_000)
            const msg = mkMessage({ id: 'm1', body: huge }) as never
            expect(extractBodyText(msg).length).toBeLessThanOrEqual(32 * 1024)
        })
    })

    describe('extractHeader', () => {
        it('returns header value case-insensitively', () => {
            const msg = mkMessage({ id: 'm1', from: 'a@b.com' }) as never
            expect(extractHeader(msg, 'from')).toBe('a@b.com')
            expect(extractHeader(msg, 'From')).toBe('a@b.com')
            expect(extractHeader(msg, 'Missing')).toBe('')
        })
    })

    describe('happy path', () => {
        it('persists conversation + task and advances lastHistoryId for one new message', async () => {
            const captured = buildDeps({
                historyResponses: [{
                    status: 200,
                    data: {
                        history: [{
                            id: '101',
                            messagesAdded: [{ message: { id: 'msg-1', threadId: 'th-1', labelIds: ['INBOX'] } }],
                        }],
                        historyId: '101',
                    },
                }],
                messages: {
                    'msg-1': mkMessage({ id: 'msg-1', threadId: 'th-1', subject: 'Hi there', from: 'alice@example.com', body: 'first message' }),
                },
            })

            await pollAllGmailChannels(captured.deps)

            expect(captured.persisted).toHaveLength(1)
            expect(captured.persisted[0]).toMatchObject({
                messageId: 'msg-1',
                threadId: 'th-1',
                subject: 'Hi there',
                from: 'alice@example.com',
                bodyText: 'first message',
            })
            expect(captured.historyIdsWritten).toEqual(['101'])
        })
    })

    describe('dedup', () => {
        it('only pushes one task when same messageId appears twice in one history response', async () => {
            const captured = buildDeps({
                historyResponses: [{
                    status: 200,
                    data: {
                        history: [
                            {
                                id: '101',
                                messagesAdded: [{ message: { id: 'msg-1', threadId: 'th-1', labelIds: ['INBOX'] } }],
                            },
                            {
                                id: '102',
                                messages: [{ id: 'msg-1', threadId: 'th-1' }],
                            },
                        ],
                        historyId: '102',
                    },
                }],
                messages: {
                    'msg-1': mkMessage({ id: 'msg-1' }),
                },
            })

            await pollAllGmailChannels(captured.deps)
            expect(captured.persisted).toHaveLength(1)
        })

        it('dedup map suppresses second persist on a follow-up poll cycle', async () => {
            // First cycle persists; second cycle re-emits the same id and must be ignored.
            const captured = buildDeps({
                historyResponses: [
                    {
                        status: 200,
                        data: {
                            history: [{ id: '101', messagesAdded: [{ message: { id: 'dup-1', threadId: 't', labelIds: ['INBOX'] } }] }],
                            historyId: '101',
                        },
                    },
                    {
                        status: 200,
                        data: {
                            history: [{ id: '102', messagesAdded: [{ message: { id: 'dup-1', threadId: 't', labelIds: ['INBOX'] } }] }],
                            historyId: '102',
                        },
                    },
                ],
                messages: { 'dup-1': mkMessage({ id: 'dup-1' }) },
            })

            await pollAllGmailChannels(captured.deps)
            await pollAllGmailChannels(captured.deps)
            expect(captured.persisted).toHaveLength(1)
        })
    })

    describe('401 → refresh → retry', () => {
        it('refreshes token on 401 and retries history fetch once', async () => {
            const captured = buildDeps({
                creds: {
                    access_token: 'expired',
                    refresh_token: 'refresh-good',
                    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                },
                historyResponses: [
                    { status: 401, error: 'unauthorized' },
                    {
                        status: 200,
                        data: {
                            history: [{ id: '201', messagesAdded: [{ message: { id: 'msg-after', threadId: 'th', labelIds: ['INBOX'] } }] }],
                            historyId: '201',
                        },
                    },
                ],
                messages: { 'msg-after': mkMessage({ id: 'msg-after' }) },
            })

            await pollAllGmailChannels(captured.deps)
            expect(captured.refreshCalls).toBe(1)
            expect(captured.persisted).toHaveLength(1)
            expect(captured.erroredChannels).toHaveLength(0)
            expect(captured.revokedConnections).toHaveLength(0)
        })

        it('marks channel errored on transient refresh failure (no connection-status flip)', async () => {
            const captured = buildDeps({
                creds: { access_token: 'expired', refresh_token: 'bad', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
                historyResponses: [{ status: 401, error: 'unauthorized' }],
                refreshResult: { kind: 'transient' },
            })

            await pollAllGmailChannels(captured.deps)
            expect(captured.erroredChannels).toHaveLength(1)
            expect(captured.erroredChannels[0]?.message).toMatch(/refresh after 401 failed/)
            expect(captured.revokedConnections).toHaveLength(0)
            expect(captured.persisted).toHaveLength(0)
        })

        it('does not crash poll loop when one channel fails — keeps iterating', async () => {
            const captured = buildDeps({
                channels: [mkChannel({ installedConnectionId: 'broken' }), { ...mkChannel(), id: 'channel-2' }],
                historyResponses: [
                    { status: 500, error: 'server error' },
                    {
                        status: 200,
                        data: {
                            history: [{ id: '300', messagesAdded: [{ message: { id: 'good-msg', threadId: 't', labelIds: ['INBOX'] } }] }],
                            historyId: '300',
                        },
                    },
                ],
                messages: { 'good-msg': mkMessage({ id: 'good-msg' }) },
            })

            await pollAllGmailChannels(captured.deps)
            expect(captured.persisted).toHaveLength(1)
            expect(captured.persisted[0]?.messageId).toBe('good-msg')
        })
    })

    describe('empty history', () => {
        it('does not write a new lastHistoryId when historyId is unchanged', async () => {
            const captured = buildDeps({
                historyResponses: [{
                    status: 200,
                    data: { history: [], historyId: '100' }, // same as channel.config.lastHistoryId
                }],
            })

            await pollAllGmailChannels(captured.deps)
            expect(captured.persisted).toHaveLength(0)
            expect(captured.historyIdsWritten).toEqual([])
        })

        it('inline-baselines channel when lastHistoryId is missing', async () => {
            const captured = buildDeps({
                channels: [{ ...mkChannel(), config: { installedConnectionId: CONNECTION_ID } }],
                baselineResult: '999',
            })

            await pollAllGmailChannels(captured.deps)
            expect(captured.baselineCalls).toBe(1)
            expect(captured.deps.fetchHistory).not.toHaveBeenCalled()
            expect(captured.persisted).toHaveLength(0)
            expect(captured.historyIdsWritten).toEqual(['999'])
            expect(captured.erroredChannels).toHaveLength(0)
        })

        it('marks channel errored when inline baseline fails', async () => {
            const captured = buildDeps({
                channels: [{ ...mkChannel(), config: { installedConnectionId: CONNECTION_ID } }],
                baselineResult: null,
            })

            await pollAllGmailChannels(captured.deps)
            expect(captured.baselineCalls).toBe(1)
            expect(captured.historyIdsWritten).toEqual([])
            expect(captured.erroredChannels).toHaveLength(1)
            expect(captured.erroredChannels[0]?.message).toMatch(/baseline historyId fetch failed/)
        })
    })

    describe('token refresh on expiry', () => {
        it('proactively refreshes when access token is within 60s of expiring', async () => {
            const captured = buildDeps({
                creds: {
                    access_token: 'about-to-expire',
                    refresh_token: 'refresh-1',
                    expires_at: new Date(Date.now() + 30_000).toISOString(),
                },
                historyResponses: [{ status: 200, data: { history: [], historyId: '100' } }],
            })

            await pollAllGmailChannels(captured.deps)
            expect(captured.refreshCalls).toBe(1)
            expect(captured.persistedCreds).toHaveLength(1)
        })
    })

    describe('history pagination (Fix 1)', () => {
        it('walks nextPageToken across pages and aggregates all messages', async () => {
            const captured = buildDeps({
                historyResponses: [
                    {
                        status: 200,
                        data: {
                            history: [{ id: '101', messagesAdded: [{ message: { id: 'msg-A', threadId: 'tA', labelIds: ['INBOX'] } }] }],
                            historyId: '101',
                            nextPageToken: 'abc',
                        },
                    },
                    {
                        status: 200,
                        data: {
                            history: [{ id: '102', messagesAdded: [{ message: { id: 'msg-B', threadId: 'tB', labelIds: ['INBOX'] } }] }],
                            historyId: '102',
                        },
                    },
                ],
                messages: {
                    'msg-A': mkMessage({ id: 'msg-A', body: 'first' }),
                    'msg-B': mkMessage({ id: 'msg-B', body: 'second' }),
                },
            })

            await pollAllGmailChannels(captured.deps)

            // 1 task pushed across both pages
            expect(captured.persisted).toHaveLength(2)
            const ids = captured.persisted.map((p) => p.messageId).sort()
            expect(ids).toEqual(['msg-A', 'msg-B'])

            // fetchHistory called twice: page 1 with no token, page 2 with 'abc'.
            expect(captured.deps.fetchHistory).toHaveBeenCalledTimes(2)
            const secondCall = (captured.deps.fetchHistory as ReturnType<typeof vi.fn>).mock.calls[1]
            expect(secondCall?.[2]).toBe('abc')

            // Watermark advances to the LAST page's historyId.
            expect(captured.historyIdsWritten).toEqual(['102'])
        })
    })

    describe('OAuth revoke vs transient (Fix 2)', () => {
        it('on invalid_grant after 401: flips connection status AND increments channel errorCount', async () => {
            const captured = buildDeps({
                creds: { access_token: 'expired', refresh_token: 'revoked', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
                historyResponses: [{ status: 401, error: 'unauthorized' }],
                refreshResult: { kind: 'invalid_grant' },
            })

            await pollAllGmailChannels(captured.deps)

            expect(captured.revokedConnections).toHaveLength(1)
            expect(captured.revokedConnections[0]?.id).toBe(CONNECTION_ID)
            expect(captured.erroredChannels).toHaveLength(1)
            expect(captured.persisted).toHaveLength(0)
        })

        it('on transient 5xx during proactive refresh: channel errorCount only, connection untouched', async () => {
            const captured = buildDeps({
                creds: { access_token: 'about-to-expire', refresh_token: 'rt', expires_at: new Date(Date.now() + 10_000).toISOString() },
                refreshResult: { kind: 'transient' },
            })

            await pollAllGmailChannels(captured.deps)

            expect(captured.erroredChannels).toHaveLength(1)
            expect(captured.erroredChannels[0]?.message).toMatch(/transient/)
            expect(captured.revokedConnections).toHaveLength(0)
        })

        it('happy path: proactive refresh succeeds → no error tracking on channel or connection', async () => {
            const captured = buildDeps({
                creds: { access_token: 'about-to-expire', refresh_token: 'rt', expires_at: new Date(Date.now() + 30_000).toISOString() },
                historyResponses: [{ status: 200, data: { history: [], historyId: '100' } }],
            })

            await pollAllGmailChannels(captured.deps)

            expect(captured.refreshCalls).toBe(1)
            expect(captured.erroredChannels).toHaveLength(0)
            expect(captured.revokedConnections).toHaveLength(0)
        })
    })
})
