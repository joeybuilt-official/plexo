// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Injection port for outbound attachment resolution + audit emit.
 *
 * Cross-package layering: connection factories live in @plexo/agent and
 * cannot import from apps/api. The resolver (DB + MinIO) and audit
 * emitter (audit_log) live in apps/api/src/lib. apps/api wires this port
 * at boot via `setOutboundAttachmentsHandler`; the factory calls through.
 *
 * If the port is unset (e.g. unit tests, agent-only contexts), attempts
 * to send attachments fail closed with a clear error.
 */

export type OutboundForwardInput = { contentHash: string }
export type OutboundUploadInput = { filename: string; mimeType: string; bytesBase64: string }
export type OutboundAttachmentInput = OutboundForwardInput | OutboundUploadInput

export interface OutboundResolvedAttachment {
    filename: string
    mimeType: string
    bytes: Buffer
    sizeBytes: number
    contentHash?: string
    sourceConversationId?: string
    source: 'forward' | 'upload'
}

export interface OutboundResolveResult {
    ok: boolean
    resolved?: OutboundResolvedAttachment[]
    error?: string
    rejected?: Array<{ index: number; reason: string }>
}

export interface OutboundResolveContext {
    workspaceId: string
    operatorUserId?: string
}

export interface OutboundAttachmentsHandler {
    resolve(
        inputs: OutboundAttachmentInput[],
        ctx: OutboundResolveContext,
    ): Promise<OutboundResolveResult>
    emitSent(payload: {
        workspaceId: string
        conversationIds: string[]
        recipientEmail: string
        channelType: string
        count: number
        totalBytes: number
        contentHashes: string[]
    }): Promise<void>
}

let handler: OutboundAttachmentsHandler | null = null

export function setOutboundAttachmentsHandler(h: OutboundAttachmentsHandler | null): void {
    handler = h
}

export function getOutboundAttachmentsHandler(): OutboundAttachmentsHandler | null {
    return handler
}
