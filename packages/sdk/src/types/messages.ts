// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel Message Protocol Types
 * Corresponds to §6 of the Kapsel Protocol Specification v0.2.0
 */

export type MessageType =
    | 'invoke'
    | 'invoke_result'
    | 'event'
    | 'channel_message'
    | 'channel_send'
    | 'channel_health_check'
    | 'channel_health_result'
    | 'activate'
    | 'deactivate'
    | 'error'

export type ErrorCode =
    | 'CAPABILITY_DENIED'
    | 'TOOL_NOT_FOUND'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR'
    | 'INVALID_PARAMS'
    | 'COMPLIANCE_INSUFFICIENT'
    | 'NOT_IMPLEMENTED'
    | 'EXTENSION_CRASHED'

export interface KapselMessage {
    /** Kapsel spec version */
    kapsel: '0.2.0'
    /** Unique message ID */
    id: string
    type: MessageType
    /** ISO 8601 timestamp */
    timestamp: string
    payload: unknown
}

export interface KapselError {
    code: ErrorCode
    message: string
    /** Original error detail — stripped in production */
    detail?: string
    retryable: boolean
}

export type MessagePriority = 'normal' | 'high' | 'urgent'

export interface Attachment {
    type: 'image' | 'file' | 'link'
    url: string
    name?: string
    mimeType?: string
}

export interface InboundMessage {
    id: string
    channelId: string
    senderId: string
    text: string
    priority: MessagePriority
    attachments?: Attachment[]
    replyToId?: string
    timestamp: string
}

export interface OutboundMessage {
    text: string
    priority?: MessagePriority
    attachments?: Attachment[]
    replyToId?: string
}

export interface InvokeContext {
    workspaceId: string
    taskId?: string
    requestId: string
}

export interface WorkerContext {
    extensionName: string
    workspaceId: string
    capabilities: string[]
}
