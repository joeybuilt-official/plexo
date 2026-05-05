// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0012 §D3 — gmail-attachments enqueueScan wiring.
 *
 * Verifies that `extractAndStoreAttachments` calls the injected `enqueueScan`
 * dependency with the row shape required by `attachment_scan_queue` and that
 * repeated calls with the same contentHash are safe (idempotency is the
 * caller's `onConflictDoNothing` contract — here we just assert the test
 * passes a duplicate `enqueueScan` dep that simulates that semantic).
 */

import { describe, it, expect, vi } from 'vitest'
import {
    extractAndStoreAttachments,
    type GmailMessageLike,
    type AttachmentDeps,
} from '../gmail-attachments.js'

function makeMsg(): GmailMessageLike {
    return {
        id: 'msg-enq-1',
        payload: {
            mimeType: 'multipart/mixed',
            parts: [
                {
                    filename: 'report.pdf',
                    mimeType: 'application/pdf',
                    body: { attachmentId: 'att-pdf', size: 1024 },
                },
            ],
        },
    }
}

function makeBaseDeps(): AttachmentDeps {
    return {
        fetchAttachment: vi.fn(async () => ({
            status: 200,
            bytes: Buffer.from('hello-world-bytes'),
        })),
        uploadAttachment: vi.fn(async ({ contentHash, filename }) => ({
            url: `s3://bkt/attachments/ws/${contentHash}-${filename}`,
        })),
    }
}

describe('extractAndStoreAttachments → enqueueScan wiring', () => {
    it('calls enqueueScan once per stored attachment with the queue-row shape', async () => {
        const enqueueScan = vi.fn(async () => undefined)
        const deps: AttachmentDeps = { ...makeBaseDeps(), enqueueScan }

        const result = await extractAndStoreAttachments({
            msg: makeMsg(),
            accessToken: 'tok',
            workspaceId: 'ws-1',
            channelId: 'ch-1',
            conversationId: 'conv-42',
            deps,
        })

        expect(result).toHaveLength(1)
        expect(enqueueScan).toHaveBeenCalledTimes(1)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const call: any = (enqueueScan.mock.calls[0] as unknown as unknown[])[0]
        expect(call).toMatchObject({
            workspaceId: 'ws-1',
            conversationId: 'conv-42',
            mimeType: 'application/pdf',
            sizeBytes: Buffer.from('hello-world-bytes').byteLength,
        })
        expect(call.contentHash).toMatch(/^[a-f0-9]{64}$/)
        expect(call.storageUrl).toMatch(/^s3:\/\//)
    })

    it('falls back to a synthesized conversationId when the caller does not pass one', async () => {
        const enqueueScan = vi.fn(async () => undefined)
        const deps: AttachmentDeps = { ...makeBaseDeps(), enqueueScan }

        await extractAndStoreAttachments({
            msg: makeMsg(),
            accessToken: 'tok',
            workspaceId: 'ws-1',
            channelId: 'ch-1',
            deps,
        })

        expect(enqueueScan).toHaveBeenCalledTimes(1)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const call: any = (enqueueScan.mock.calls[0] as unknown as unknown[])[0]
        // UUID v4-ish — at minimum non-empty string of decent length
        expect(typeof call.conversationId).toBe('string')
        expect(call.conversationId.length).toBeGreaterThanOrEqual(8)
    })

    it('enqueueScan failures are non-fatal — extractAndStoreAttachments still returns the metadata', async () => {
        const enqueueScan = vi.fn(async () => { throw new Error('queue down') })
        const deps: AttachmentDeps = { ...makeBaseDeps(), enqueueScan }

        const result = await extractAndStoreAttachments({
            msg: makeMsg(),
            accessToken: 'tok',
            workspaceId: 'ws-1',
            channelId: 'ch-1',
            conversationId: 'conv-9',
            deps,
        })

        // Attachment was still stored.
        expect(result).toHaveLength(1)
        expect(result[0]!.scanStatus).toBe('unscanned')
    })

    it('onConflictDoNothing semantic: simulating a duplicate enqueue (same contentHash) is harmless', async () => {
        // Simulate the queue's UNIQUE(content_hash) by ignoring duplicate inserts.
        const seen = new Set<string>()
        const enqueueScan = vi.fn(async (row: { contentHash: string }) => {
            if (seen.has(row.contentHash)) return // mimic onConflictDoNothing
            seen.add(row.contentHash)
        })
        const deps: AttachmentDeps = { ...makeBaseDeps(), enqueueScan }

        // Two messages with identical bytes → same contentHash → second enqueue is a no-op.
        await extractAndStoreAttachments({
            msg: makeMsg(),
            accessToken: 'tok',
            workspaceId: 'ws-1',
            channelId: 'ch-1',
            conversationId: 'conv-A',
            deps,
        })
        await extractAndStoreAttachments({
            msg: { ...makeMsg(), id: 'msg-enq-2' },
            accessToken: 'tok',
            workspaceId: 'ws-1',
            channelId: 'ch-1',
            conversationId: 'conv-B',
            deps,
        })

        expect(enqueueScan).toHaveBeenCalledTimes(2)
        expect(seen.size).toBe(1) // one unique contentHash retained
    })
})
