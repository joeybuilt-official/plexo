// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi } from 'vitest'
import {
    collectAttachmentParts,
    decodeBase64url,
    extractAndStoreAttachments,
    type GmailMessageLike,
} from '../gmail-attachments.js'

describe('collectAttachmentParts', () => {
    it('returns empty for no payload', () => {
        expect(collectAttachmentParts(undefined)).toEqual([])
    })
    it('finds attachments at top level', () => {
        const part = {
            filename: 'a.pdf',
            mimeType: 'application/pdf',
            body: { attachmentId: 'att-1', size: 100 },
        }
        expect(collectAttachmentParts(part)).toHaveLength(1)
    })
    it('walks nested parts (multipart/mixed → multipart/related → leaf)', () => {
        const tree = {
            mimeType: 'multipart/mixed',
            parts: [
                { mimeType: 'text/plain', body: { data: 'aGVsbG8' } },
                {
                    mimeType: 'multipart/related',
                    parts: [
                        { filename: 'photo.png', mimeType: 'image/png', body: { attachmentId: 'att-2', size: 5000 } },
                        { filename: 'doc.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-3', size: 80000 } },
                    ],
                },
            ],
        }
        expect(collectAttachmentParts(tree as any)).toHaveLength(2)
    })
    it('skips parts without filename OR without attachmentId', () => {
        const tree = {
            parts: [
                { filename: 'noatt.txt', mimeType: 'text/plain', body: { data: 'plain', size: 10 } }, // no attachmentId
                { mimeType: 'application/pdf', body: { attachmentId: 'att-x', size: 100 } }, // no filename
            ],
        }
        expect(collectAttachmentParts(tree as any)).toEqual([])
    })
})

describe('decodeBase64url', () => {
    it('decodes Gmail-style base64url with - and _ alphabet', () => {
        const out = decodeBase64url('SGVsbG8tV29ybGQ_')
        expect(out.toString('utf8')).toBe('Hello-World?')
    })
    it('handles missing padding', () => {
        expect(decodeBase64url('aGVsbG8').toString('utf8')).toBe('hello')
    })
})

describe('extractAndStoreAttachments — happy path', () => {
    it('fetches + uploads accepted attachments; rejects blocked ones', async () => {
        const msg: GmailMessageLike = {
            id: 'msg-1',
            payload: {
                mimeType: 'multipart/mixed',
                parts: [
                    { mimeType: 'text/plain', body: { data: 'aGVsbG8' } },
                    { filename: 'photo.png', mimeType: 'image/png', body: { attachmentId: 'att-png', size: 1024 } },
                    { filename: 'innocent.exe', mimeType: 'application/octet-stream', body: { attachmentId: 'att-exe', size: 2048 } },
                ],
            },
        }
        const fetchAttachment = vi.fn(async (_token: string, _msgId: string, attId: string) => ({
            status: 200,
            bytes: Buffer.from(`fake-bytes-for-${attId}`),
        }))
        const uploadAttachment = vi.fn(async ({ contentHash, filename }: { contentHash: string; filename: string }) => ({
            url: `s3://bucket/attachments/ws/${contentHash}-${filename}`,
        }))
        const onAuditEvent = vi.fn()

        const result = await extractAndStoreAttachments({
            msg,
            accessToken: 'tok',
            workspaceId: 'ws-1',
            channelId: 'ch-1',
            deps: { fetchAttachment, uploadAttachment },
            onAuditEvent,
        })

        // Only the PNG was accepted; .exe rejected before fetch.
        expect(result).toHaveLength(1)
        expect(result[0]!.filename).toBe('photo.png')
        expect(result[0]!.scanStatus).toBe('unscanned')
        expect(result[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/)
        expect(fetchAttachment).toHaveBeenCalledTimes(1)
        expect(fetchAttachment).toHaveBeenCalledWith('tok', 'msg-1', 'att-png')
        expect(uploadAttachment).toHaveBeenCalledTimes(1)
        // Audit events: 1 fetched (PNG), 1 rejected (EXE)
        const events = onAuditEvent.mock.calls.map(([kind]) => kind)
        expect(events.filter((e: string) => e === 'fetched')).toHaveLength(1)
        expect(events.filter((e: string) => e === 'rejected')).toHaveLength(1)
    })

    it('aggregate gate trips when count exceeds 20', async () => {
        const parts = Array.from({ length: 21 }, (_, i) => ({
            filename: `f${i}.png`,
            mimeType: 'image/png',
            body: { attachmentId: `att-${i}`, size: 100 },
        }))
        const msg: GmailMessageLike = { id: 'msg-2', payload: { parts } }
        const fetchAttachment = vi.fn()
        const uploadAttachment = vi.fn()

        const result = await extractAndStoreAttachments({
            msg, accessToken: 't', workspaceId: 'ws', channelId: 'ch',
            deps: { fetchAttachment, uploadAttachment },
        })
        expect(result).toEqual([])
        expect(fetchAttachment).not.toHaveBeenCalled()
        expect(uploadAttachment).not.toHaveBeenCalled()
    })

    it('returns empty + does not throw on fetch 4xx', async () => {
        const msg: GmailMessageLike = {
            id: 'msg-3',
            payload: { parts: [{ filename: 'a.pdf', mimeType: 'application/pdf', body: { attachmentId: 'x', size: 100 } }] },
        }
        const fetchAttachment = vi.fn(async () => ({ status: 404, error: 'not found' }))
        const uploadAttachment = vi.fn()

        const result = await extractAndStoreAttachments({
            msg, accessToken: 't', workspaceId: 'ws', channelId: 'ch',
            deps: { fetchAttachment, uploadAttachment },
        })
        expect(result).toEqual([])
        expect(uploadAttachment).not.toHaveBeenCalled()
    })

    it('returns empty when no candidates exist (no payload, no parts)', async () => {
        const msg: GmailMessageLike = { id: 'msg-4' }
        const result = await extractAndStoreAttachments({
            msg, accessToken: 't', workspaceId: 'ws', channelId: 'ch',
            deps: { fetchAttachment: vi.fn(), uploadAttachment: vi.fn() },
        })
        expect(result).toEqual([])
    })

    it('contentHash is deterministic for identical bytes', async () => {
        const msg: GmailMessageLike = {
            id: 'msg-5',
            payload: {
                parts: [
                    { filename: 'a.txt', mimeType: 'text/plain', body: { attachmentId: 'a1', size: 5 } },
                    { filename: 'b.txt', mimeType: 'text/plain', body: { attachmentId: 'a2', size: 5 } },
                ],
            },
        }
        const sameBytes = Buffer.from('hello')
        const fetchAttachment = vi.fn(async () => ({ status: 200, bytes: sameBytes }))
        const uploadAttachment = vi.fn(async ({ contentHash, filename }: { contentHash: string; filename: string }) => ({
            url: `s3://b/${contentHash}-${filename}`,
        }))

        const result = await extractAndStoreAttachments({
            msg, accessToken: 't', workspaceId: 'ws', channelId: 'ch',
            deps: { fetchAttachment, uploadAttachment },
        })
        expect(result).toHaveLength(2)
        expect(result[0]!.contentHash).toBe(result[1]!.contentHash)
    })
})
