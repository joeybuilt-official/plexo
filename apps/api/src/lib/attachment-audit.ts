// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0012 §D4 / §D9 — shared audit emitters for attachment lifecycle events.
 *
 * Two events:
 *   - `attachment.fetched`  — emitted at ingest (gmail-attachments.ts)
 *   - `attachment.scanned`  — emitted by the scan worker + admin rescan trigger
 *
 * The scan worker has no Hono/Express request context, so both helpers route
 * through `recordAuditEventDirect` which is the non-req variant of `audit()`.
 */

import { recordAuditEventDirect } from '../audit.js'

export interface AttachmentFetchedPayload {
    workspaceId: string
    contentHash: string
    filename: string
    sizeBytes: number
    mimeType?: string
    messageId?: string
    channel?: string
}

export interface AttachmentScannedPayload {
    workspaceId: string
    contentHash: string
    status: 'clean' | 'infected' | 'error'
    scanner: string
    signature?: string | null
    signatureDb?: string | null
    durationMs: number
    error?: string | null
}

export function emitAttachmentFetched(payload: AttachmentFetchedPayload): void {
    recordAuditEventDirect({
        workspaceId: payload.workspaceId,
        action: 'attachment.fetched',
        resource: 'conversations.attachments',
        resourceId: payload.contentHash,
        metadata: {
            filename: payload.filename,
            sizeBytes: payload.sizeBytes,
            mimeType: payload.mimeType ?? null,
            messageId: payload.messageId ?? null,
            channel: payload.channel ?? null,
        },
    })
}

export function emitAttachmentScanned(payload: AttachmentScannedPayload): void {
    recordAuditEventDirect({
        workspaceId: payload.workspaceId,
        action: 'attachment.scanned',
        resource: 'conversations.attachments',
        resourceId: payload.contentHash,
        metadata: {
            status: payload.status,
            scanner: payload.scanner,
            signature: payload.signature ?? null,
            signatureDb: payload.signatureDb ?? null,
            durationMs: payload.durationMs,
            error: payload.error ?? null,
        },
    })
}

/**
 * ADR 0013 §D8 — outbound emitters.
 *
 * Both helpers take a `deps` arg for symmetry with future test injection;
 * today only `workspaceId` is read off it. Calls are fire-and-forget via
 * `recordAuditEventDirect`, so the awaited `Promise<void>` is settled as
 * soon as the call is enqueued.
 */
export interface OutboundAuditDeps {
    workspaceId: string
}

export interface AttachmentSentPayload {
    conversationIds: string[]
    recipientEmail: string
    channelType: string
    count: number
    totalBytes: number
    contentHashes: string[]
}

export interface AttachmentOutboundBlockedPayload {
    contentHash?: string
    reason: string
    filename?: string
    sizeBytes?: number
}

export async function emitAttachmentSent(
    deps: OutboundAuditDeps,
    payload: AttachmentSentPayload,
): Promise<void> {
    recordAuditEventDirect({
        workspaceId: deps.workspaceId,
        action: 'attachment.sent',
        resource: 'conversations.attachments',
        resourceId: payload.conversationIds[0] ?? 'attachment-only',
        metadata: {
            conversationIds: payload.conversationIds,
            recipientEmail: payload.recipientEmail,
            channelType: payload.channelType,
            count: payload.count,
            totalBytes: payload.totalBytes,
            contentHashes: payload.contentHashes,
        },
    })
}

export async function emitAttachmentOutboundBlocked(
    deps: OutboundAuditDeps,
    payload: AttachmentOutboundBlockedPayload,
): Promise<void> {
    recordAuditEventDirect({
        workspaceId: deps.workspaceId,
        action: 'attachment.outbound_blocked',
        resource: 'conversations.attachments',
        resourceId: payload.contentHash,
        metadata: {
            contentHash: payload.contentHash ?? null,
            reason: payload.reason,
            filename: payload.filename ?? null,
            sizeBytes: payload.sizeBytes ?? null,
        },
    })
}
