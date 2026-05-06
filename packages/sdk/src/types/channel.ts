// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PEX Channel Contract Types
 * Corresponds to §2.3 and §9.2 of the Plexo Extension Protocol (PEX) Specification v0.4.0
 */

import type { InboundMessage } from './messages.js'

export interface ChannelHealthResult {
    healthy: boolean
    latencyMs?: number
    error?: string
}

export interface ChannelSendResult {
    ok: boolean
    messageId?: string
    error?: string
}

export interface ChannelExtension {
    /**
     * Called on activate. Channel should start listening for inbound messages
     * and call sdk.channel.send() to route them into the host.
     */
    onActivate(): Promise<void>

    /**
     * Called when the host wants to send a message via this channel.
     * Requires channel:receive capability.
     */
    onMessage(message: InboundMessage): Promise<void>

    /**
     * Called periodically by the host Channel Router.
     * Return healthy: false to trigger failover.
     */
    healthCheck(): Promise<ChannelHealthResult>

    /**
     * Called on deactivate. Channel should stop listeners and clean up.
     */
    onDeactivate(): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Channel subscription contract (ADR-0002)
//
// The subscription contract lets sibling apps (Levio, future Fonto/Nexalog)
// read/send/observe Channels owned by Plexo Core. Types live alongside the
// `ChannelExtension` runtime contract because they share the same Pex layer.
// Pex SPEC stays at 0.4.0 — this is host-side REST + SSE, not a protocol bump.
// ─────────────────────────────────────────────────────────────────────────────

export type PexVersion = '0.4.0'

export const PEX_VERSION: PexVersion = '0.4.0'

/** Channel runtime types known to Plexo. Mirrors `channel_type` enum. */
export type ChannelType =
    | 'telegram'
    | 'slack'
    | 'discord'
    | 'whatsapp'
    | 'signal'
    | 'matrix'
    | 'irc'
    | 'webchat'
    | 'twilio'
    | 'gmail'
    | 'gmessages'

/** Connection state machine surfaced to subscribers (ADR-0004 + ADR-0005). */
export type ConnectionState =
    | 'paired'
    | 'active'
    | 'refreshing'
    | 'expired'
    | 'revoked'
    | 'errored'

export interface ChannelAttachmentRef {
    /** Plexo-side attachment ID, resolvable via the attachment store. */
    id: string
    /** MIME type if known. */
    mimeType?: string
    /** Display filename. */
    filename?: string
    /** Size in bytes if known. */
    sizeBytes?: number
    /** Optional thumbnail attachment ID for image/video previews. */
    thumbnailId?: string
}

/** Canonical message envelope used by every Channel subscriber. */
export interface ChannelMessage {
    id: string
    channelId: string
    threadId: string
    direction: 'inbound' | 'outbound'
    /** Plain text body. Markdown is not parsed by Plexo's generic viewer. */
    text: string
    attachments?: ChannelAttachmentRef[]
    /** Sender identifier in the channel's native namespace (phone number, handle, etc.). */
    senderId: string
    /** Display name if the channel resolves one. */
    senderName?: string
    /** ISO-8601 timestamp when the message was authored upstream. */
    sentAt: string
    /** Channel-specific metadata — RCS feature flags, read receipts, etc. */
    metadata?: Record<string, unknown>
    pexVersion: PexVersion
}

export interface ChannelThread {
    id: string
    channelId: string
    /** Display title. For 1:1 threads this is typically the contact name or phone. */
    title: string
    /** Most recent message preview (text-only, truncated). */
    lastMessagePreview?: string
    lastMessageAt?: string
    unreadCount?: number
    /** Channel-specific metadata (e.g., is_rcs flag for gmessages). */
    metadata?: Record<string, unknown>
    pexVersion: PexVersion
}

export interface ChannelDescriptor {
    id: string
    workspaceId: string
    type: ChannelType
    name: string
    state: ConnectionState
    enabled: boolean
    lastMessageAt?: string
    pexVersion: PexVersion
}

/** Connection (credential) descriptor — paired-session metadata, no secrets. */
export interface PairedConnectionDescriptor {
    id: string
    workspaceId: string
    registryId: string
    state: ConnectionState
    pairedAt?: string
    lastInboundAt?: string
    decodeErrorCount?: number
    pexVersion: PexVersion
}

export type ChannelEvent =
    | {
          type: 'message.received'
          channelId: string
          threadId: string
          message: ChannelMessage
          pexVersion: PexVersion
      }
    | {
          type: 'message.sent'
          channelId: string
          threadId: string
          message: ChannelMessage
          pexVersion: PexVersion
      }
    | {
          type: 'connection.state_changed'
          channelId: string
          state: ConnectionState
          pexVersion: PexVersion
      }

export interface ChannelSubscription {
    id: string
    appId: string
    channelId: string
    scopes: ChannelScope[]
    createdAt: string
}

export type ChannelScope =
    | 'channels:list'
    | 'channels:subscribe'
    | 'channels:read'
    | 'channels:send'
    | 'channels:events'

export interface ChannelSendRequest {
    text: string
    attachments?: ChannelAttachmentRef[]
    /** Caller-supplied idempotency token; Plexo dedupes within a 24h window. */
    idempotencyKey: string
}

export interface ChannelMessagePage {
    messages: ChannelMessage[]
    nextCursor?: string
}

export interface ChannelThreadPage {
    threads: ChannelThread[]
    nextCursor?: string
}
