// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0013 — gmailSend with attachments.
 *
 * Mocks:
 *   - global fetch (Gmail API + token-refresh URL).
 *   - @plexo/db: returns a fake channel + installed_connection row.
 *   - ../connections/crypto-util.js: identity decrypt to skip ENCRYPTION_SECRET.
 *
 * Asserts the POSTed `raw` field round-trips multipart correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@plexo/db', () => {
    const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })
    return {
        db: {
            select: vi.fn(() => ({
                from: vi.fn((table: unknown) => {
                    const tableName = (table as { __tableName?: string }).__tableName
                    return {
                        where: vi.fn(() => ({
                            limit: vi.fn(async () => {
                                if (tableName === 'channels') {
                                    return [{
                                        workspaceId: 'ws-1',
                                        type: 'gmail',
                                        enabled: true,
                                        config: { installedConnectionId: 'ic-1', emailAddress: 'agent@plexo.test' },
                                    }]
                                }
                                if (tableName === 'installed_connections') {
                                    return [{
                                        id: 'ic-1',
                                        credentials: { encrypted: 'TOKEN_PLACEHOLDER' },
                                    }]
                                }
                                return []
                            }),
                        })),
                    }
                }),
            })),
            update: vi.fn(() => ({
                set: vi.fn(() => ({
                    where: vi.fn(async () => undefined),
                })),
            })),
            execute: vi.fn(async () => []),
        },
        sql: sqlTag,
        eq: vi.fn((col: unknown, val: unknown) => ({ col, val, _kind: 'eq' })),
        and: vi.fn(),
        or: vi.fn(),
        ne: vi.fn(),
        desc: vi.fn(),
        asc: vi.fn(),
        inArray: vi.fn(),
        isNull: vi.fn(),
        isNotNull: vi.fn(),
        ilike: vi.fn(),
        lt: vi.fn(),
        lte: vi.fn(),
        gte: vi.fn(),
        count: vi.fn(),
        channels: { __tableName: 'channels', id: { name: 'id' } },
        installedConnections: { __tableName: 'installed_connections', id: { name: 'id' } },
    }
})

vi.mock('../../connections/crypto-util.js', () => ({
    decrypt: vi.fn((_token: string, _workspaceId: string) => JSON.stringify({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        email: 'agent@plexo.test',
    })),
    encrypt: vi.fn((s: string) => s),
}))

import { gmailSend } from '../gmail-send.js'
import { buildMime } from '../multipart-builder.js'

const CRLF = '\r\n'

interface CapturedSend {
    raw: string
    threadId?: string
}

function captureFetch(): { mock: ReturnType<typeof vi.fn>; sent: CapturedSend[] } {
    const sent: CapturedSend[] = []
    const mock = vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes('gmail.googleapis.com')) {
            const body = JSON.parse(init.body as string) as { raw: string; threadId?: string }
            // Decode base64url back to raw MIME for assertion.
            const padded = body.raw.replace(/-/g, '+').replace(/_/g, '/')
            const padding = '='.repeat((4 - (padded.length % 4)) % 4)
            const decoded = Buffer.from(padded + padding, 'base64').toString('utf8')
            sent.push({ raw: decoded, threadId: body.threadId })
            return new Response(JSON.stringify({ id: 'msg-1', threadId: 'th-1' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        }
        return new Response('{}', { status: 200 })
    })
    return { mock, sent }
}

function parseHeaders(block: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of block.split(CRLF)) {
        const idx = line.indexOf(':')
        if (idx === -1) continue
        out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
    }
    return out
}

interface ParsedMime {
    topHeaders: Record<string, string>
    parts: Array<{ headers: Record<string, string>; body: string }>
}

function parseMime(raw: string): ParsedMime {
    const sep = raw.indexOf(CRLF + CRLF)
    const headerBlock = raw.slice(0, sep)
    const body = raw.slice(sep + 4)
    const topHeaders = parseHeaders(headerBlock)
    const m = (topHeaders['content-type'] ?? '').match(/boundary="?([^";\s]+)"?/i)
    if (!m) return { topHeaders, parts: [{ headers: topHeaders, body }] }
    const delim = `--${m[1]!}`
    const parts: ParsedMime['parts'] = []
    for (const seg of body.split(delim)) {
        if (seg === '' || seg.startsWith('--')) continue
        let s = seg
        if (s.startsWith(CRLF)) s = s.slice(2)
        if (s.endsWith(CRLF)) s = s.slice(0, -2)
        const innerSep = s.indexOf(CRLF + CRLF)
        if (innerSep === -1) continue
        parts.push({
            headers: parseHeaders(s.slice(0, innerSep)),
            body: s.slice(innerSep + 4),
        })
    }
    return { topHeaders, parts }
}

describe('gmailSend — regression: no attachments', () => {
    let fetchMock: ReturnType<typeof captureFetch>
    beforeEach(() => {
        fetchMock = captureFetch()
        global.fetch = fetchMock.mock as unknown as typeof fetch
    })

    it('emits identical bytes to buildMime() for the no-attachment path', async () => {
        const result = await gmailSend({
            channelId: 'ch-1',
            to: 'recipient@example.com',
            subject: 'Hello',
            body: 'Plain body text.',
        })
        expect(result.ok).toBe(true)
        expect(fetchMock.sent).toHaveLength(1)

        const expected = buildMime({
            from: 'agent@plexo.test',
            to: 'recipient@example.com',
            subject: 'Hello',
            bodyText: 'Plain body text.',
        })
        expect(fetchMock.sent[0]!.raw).toBe(expected.raw)
        expect(fetchMock.sent[0]!.raw).not.toMatch(/multipart/i)
    })
})

describe('gmailSend — single PDF attachment', () => {
    let fetchMock: ReturnType<typeof captureFetch>
    beforeEach(() => {
        fetchMock = captureFetch()
        global.fetch = fetchMock.mock as unknown as typeof fetch
    })

    it('produces multipart/mixed; PDF bytes round-trip', async () => {
        const pdf = Buffer.from('%PDF-1.4\n<<binary>>\n%%EOF\n', 'utf8')
        const result = await gmailSend({
            channelId: 'ch-1',
            to: 'recipient@example.com',
            subject: 'Report attached',
            body: 'See attached.',
            attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', bytes: pdf }],
        })
        expect(result.ok).toBe(true)
        const raw = fetchMock.sent[0]!.raw
        expect(raw.toLowerCase()).toContain('content-type: multipart/mixed')

        const parsed = parseMime(raw)
        expect(parsed.parts).toHaveLength(2)
        const filePart = parsed.parts[1]!
        expect(filePart.headers['content-type']).toMatch(/application\/pdf/)
        expect(filePart.headers['content-disposition']).toMatch(/attachment; filename="report\.pdf"/)
        const decoded = Buffer.from(filePart.body.replace(/\r?\n/g, ''), 'base64')
        expect(decoded.equals(pdf)).toBe(true)
    })
})

describe('gmailSend — pre-flight 25 MiB cap', () => {
    let fetchMock: ReturnType<typeof captureFetch>
    beforeEach(() => {
        fetchMock = captureFetch()
        global.fetch = fetchMock.mock as unknown as typeof fetch
    })

    it('rejects 30 MiB attachment without calling Gmail API', async () => {
        const huge = Buffer.alloc(30 * 1024 * 1024)
        const result = await gmailSend({
            channelId: 'ch-1',
            to: 'recipient@example.com',
            subject: 'too big',
            body: 'oversized payload',
            attachments: [{ filename: 'huge.pdf', mimeType: 'application/pdf', bytes: huge }],
        })
        expect(result.ok).toBe(false)
        expect(result.status).toBe(413)
        expect(result.error).toMatch(/PAYLOAD_TOO_LARGE/)
        expect(fetchMock.sent).toHaveLength(0)
    })
})
