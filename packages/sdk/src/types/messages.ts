// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel Message Protocol Types
 * Corresponds to §6 of the Kapsel Protocol Specification v0.3.0
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
    // v0.3.0 additions
    | 'escalation_request'    // §23 — agent requests human approval
    | 'escalation_response'   // §23 — host relays user decision
    | 'entity_resolve'        // §16 — entity resolution request
    | 'entity_resolve_result' // §16 — entity resolution response
    | 'a2a_inbound'           // §22 — inbound A2A task
    | 'a2a_outbound'          // §22 — outbound A2A delegation
    | 'self_read'             // §20 — UserSelf read request
    | 'self_propose'          // §20 — UserSelf proposal
    | 'audit_query'           // §18 — audit trail query

export type ErrorCode =
    | 'CAPABILITY_DENIED'
    | 'TOOL_NOT_FOUND'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR'
    | 'INVALID_PARAMS'
    | 'COMPLIANCE_INSUFFICIENT'
    | 'NOT_IMPLEMENTED'
    | 'EXTENSION_CRASHED'
    // v0.3.0 additions
    | 'TRUST_TIER_EXCEEDED'       // §17 — capability exceeds trust tier
    | 'DATA_RESIDENCY_VIOLATION'  // §19 — unauthorized external call
    | 'ESCALATION_DENIED'         // §23 — user denied escalation
    | 'ESCALATION_TIMEOUT'        // §23 — no user response in time
    | 'ENTITY_NOT_FOUND'          // §16 — entity resolution failed
    | 'DID_VERIFICATION_FAILED'   // §21 — DID or VC verification failure
    | 'MODEL_REQUIREMENTS_UNMET'  // §24 — host cannot satisfy model requirements
    | 'SCOPED_MEMORY_REQUIRED'    // §4  — unscoped memory token at Standard+ host

export interface KapselMessage {
    /** Kapsel spec version */
    kapsel: '0.3.0'
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
