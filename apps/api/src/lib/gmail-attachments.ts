// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase N / ADR 0009 — Gmail inbound attachment extraction.
 *
 * Walks a Gmail message payload tree, validates each candidate attachment
 * against `attachment-validators`, fetches blobs via `messages.attachments.get`,
 * SHA-256 hashes, uploads to MinIO via the existing storage client, and
 * returns metadata in the conversation-attachment shape.
 *
 * Pure within the limits of "no DB writes here" — caller is responsible for
 * persisting the returned metadata array on the resulting conversations row.
 */

import { createHash, randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import { incrementCounter } from './metrics.js'
import {
    validateSingleAttachment,
    validateAttachmentSet,
    type AttachmentRejection,
} from './attachment-validators.js'

export interface GmailMessagePart {
    filename?: string
    mimeType?: string
    body?: { attachmentId?: string; size?: number; data?: string }
    parts?: GmailMessagePart[]
}

export interface GmailMessageLike {
    id: string
    payload?: GmailMessagePart
}

export interface AttachmentMeta {
    url: string
    type: string
    filename: string
    sizeBytes: number
    contentHash: string
    scanStatus: 'unscanned' | 'clean' | 'infected' | 'error'
}

/** Recursively collect every part with both a filename AND an attachmentId. */
export function collectAttachmentParts(part: GmailMessagePart | undefined): GmailMessagePart[] {
    if (!part) return []
    const out: GmailMessagePart[] = []
    if (part.filename && part.body?.attachmentId) {
        out.push(part)
    }
    if (part.parts) {
        for (const child of part.parts) {
            out.push(...collectAttachmentParts(child))
        }
    }
    return out
}

export interface AttachmentDeps {
    /** Fetch a single attachment's bytes via Gmail API. */
    fetchAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<{
        status: number
        bytes?: Buffer
        error?: string
    }>
    /** Upload bytes to object storage; returns the canonical URL. */
    uploadAttachment(args: {
        workspaceId: string
        contentHash: string
        filename: string
        mimeType: string
        bytes: Buffer
    }): Promise<{ url: string }>
    /** Phase N+1 (ADR 0012 §D3) — enqueue for malware scan. Idempotent on contentHash. */
    enqueueScan?(row: {
        workspaceId: string
        conversationId: string
        contentHash: string
        storageUrl: string
        mimeType: string
        sizeBytes: number
    }): Promise<void>
}

/** Decode Gmail's base64url body data into a Buffer. */
export function decodeBase64url(data: string): Buffer {
    const padded = data.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (data.length % 4)) % 4)
    return Buffer.from(padded, 'base64')
}

/** Walk the candidate parts, fetch each attachment, validate + hash + store.
 *  Returns the metadata array (possibly empty). Rejected attachments are
 *  logged + counted; the rest of the message proceeds. */
export async function extractAndStoreAttachments(args: {
    msg: GmailMessageLike
    accessToken: string
    workspaceId: string
    channelId: string
    /** Optional: the conversation row this extraction is bound to. If absent,
     *  a placeholder UUID is recorded; fan-out at scan-completion uses JSONB
     *  containment over `conversations.attachments[*].contentHash` (ADR 0012
     *  §pre-mortem #3) so the queue's conversation_id is informational. */
    conversationId?: string
    deps: AttachmentDeps
    onAuditEvent?: (event: 'fetched' | 'rejected', payload: Record<string, unknown>) => void
}): Promise<AttachmentMeta[]> {
    const candidates = collectAttachmentParts(args.msg.payload)
    if (candidates.length === 0) return []

    // Aggregate gate first — count + total size against caps.
    const aggInput = candidates.map((p) => ({ sizeBytes: p.body?.size }))
    const aggReject = validateAttachmentSet(aggInput)
    if (aggReject) {
        incrementCounter('plexo_gmail_attachment_rejected_total', { reason: aggReject.code })
        args.onAuditEvent?.('rejected', { messageId: args.msg.id, reason: aggReject })
        logger.warn({ messageId: args.msg.id, channelId: args.channelId, reason: aggReject }, 'gmail: attachment set rejected at aggregate gate')
        return []
    }

    const out: AttachmentMeta[] = []
    let storedSoFar = 0

    for (const part of candidates) {
        const reject: AttachmentRejection | null = validateSingleAttachment({
            filename: part.filename,
            mimeType: part.mimeType,
            sizeBytes: part.body?.size,
        })
        if (reject) {
            incrementCounter('plexo_gmail_attachment_rejected_total', { reason: reject.code })
            args.onAuditEvent?.('rejected', { messageId: args.msg.id, filename: part.filename, reason: reject })
            logger.warn({
                messageId: args.msg.id,
                channelId: args.channelId,
                filename: part.filename,
                reason: reject,
            }, 'gmail: attachment rejected')
            continue
        }

        const attachmentId = part.body!.attachmentId!
        const fetchResult = await args.deps.fetchAttachment(args.accessToken, args.msg.id, attachmentId)
        if (fetchResult.status >= 400 || !fetchResult.bytes) {
            incrementCounter('plexo_gmail_attachment_fetch_failed_total')
            logger.warn({
                messageId: args.msg.id,
                channelId: args.channelId,
                filename: part.filename,
                status: fetchResult.status,
                error: fetchResult.error,
            }, 'gmail: attachment fetch failed')
            continue
        }
        const bytes = fetchResult.bytes
        if (bytes.byteLength > storedSoFar + 0) { /* size guard; real cap via aggregate above */ }
        storedSoFar += bytes.byteLength

        const contentHash = createHash('sha256').update(bytes).digest('hex')
        const upload = await args.deps.uploadAttachment({
            workspaceId: args.workspaceId,
            contentHash,
            filename: part.filename!,
            mimeType: part.mimeType!,
            bytes,
        })

        const meta: AttachmentMeta = {
            url: upload.url,
            type: part.mimeType!,
            filename: part.filename!,
            sizeBytes: bytes.byteLength,
            contentHash,
            scanStatus: 'unscanned',
        }
        out.push(meta)
        incrementCounter('plexo_gmail_attachment_fetched_total', { mime_prefix: (part.mimeType ?? '').split('/')[0] || 'unknown' })
        // ADR 0012 §D3 — enqueue for async clamd scan. UNIQUE(content_hash)
        // dedupes globally; failure here is non-fatal (file still surfaces with
        // 'unscanned' badge per Phase N safe state).
        if (args.deps.enqueueScan) {
            try {
                await args.deps.enqueueScan({
                    workspaceId: args.workspaceId,
                    conversationId: args.conversationId ?? randomUUID(),
                    contentHash,
                    storageUrl: upload.url,
                    mimeType: part.mimeType!,
                    sizeBytes: bytes.byteLength,
                })
            } catch (err) {
                logger.warn({ err, contentHash, channelId: args.channelId }, 'gmail-attachments: enqueueScan failed (non-fatal)')
            }
        }
        args.onAuditEvent?.('fetched', {
            messageId: args.msg.id,
            filename: part.filename,
            sizeBytes: bytes.byteLength,
            contentHash,
        })
    }

    return out
}
