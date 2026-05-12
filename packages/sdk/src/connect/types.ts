// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AppToolConfig {
    description: string
    inputSchema?: Record<string, unknown>
    outputSchema?: Record<string, unknown>
}

export interface AppChannelConfig {
    description: string
    transport?: 'api' | 'webhook' | 'poll'
    direction?: 'inbound' | 'outbound' | 'bidirectional'
}

export interface AppConnectorConfig {
    description: string
    scopes?: string[]
}

/** Lightweight extension declaration an app registers with Plexo Core. */
export type AppExtension =
    | { id: string; type: 'tool'; name: string; config: AppToolConfig }
    | { id: string; type: 'channel'; name: string; config: AppChannelConfig }
    | { id: string; type: 'connector'; name: string; config: AppConnectorConfig }

export interface ResilienceOptions {
    /** Per-call timeout in ms. Default: 15_000. */
    timeoutMs?: number
    /** Retry backoff schedule for registration. Default: [5_000, 15_000, 45_000]. */
    registrationBackoffMs?: number[]
}

export interface PlexoClientOptions {
    /** Unique app identifier. Must match PLEXO_APP_ID (or APP_ID) in env. */
    appId: string
    /** Plexo Core base URL. e.g. https://plexo.example.com */
    plexoUrl: string
    /** Shared service key — must match PLEXO_SERVICE_KEY on Plexo Core. */
    serviceKey: string
    /** Service key version sent as X-Service-Key-Version. Default: 'v1'. */
    serviceKeyVersion?: string
    /** Human-readable app name shown in Plexo UI. Defaults to appId. */
    displayName?: string
    /** DB namespace for this app's schema objects. Defaults to appId. */
    schemaNamespace?: string
    /** Tools, channels, and connectors this app exposes to Plexo agents. */
    extensions?: AppExtension[]
    /** Event topics this app may emit. e.g. ['my-app.order.created'] */
    eventContracts?: string[]
    resilience?: ResilienceOptions
    /** Override fetch for testing or custom retry logic. */
    fetchImpl?: typeof fetch
}

// ---------------------------------------------------------------------------
// Workspace / connections
// ---------------------------------------------------------------------------

export interface PlexoConnection {
    id: string
    registryId: string
    name: string
    status: 'active' | 'disconnected' | 'error' | 'expired'
    scopesGranted: string[] | null
    lastVerifiedAt: string | null
    createdAt: string
}

export interface PlexoToken {
    access_token: string | null
    refresh_token: string | null
    expires_at: string | null
    email: string | null
    scope: string | null
}

export interface PlexoTask {
    id: string
    type: string
    status: string
    priority: number | null
    context: Record<string, unknown>
    createdAt: string
    updatedAt: string
}

export interface PlexoTokenWithConnection extends PlexoToken {
    connectionId: string
}

export interface InstallConnectionOptions {
    workspaceId: string
    registryId: string
    name: string
    credentials?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// AI / chat
// ---------------------------------------------------------------------------

export interface AiMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export interface AiCompleteOptions {
    messages: AiMessage[]
    systemPrompt?: string
    maxTokens?: number
    taskType?: string
}

export interface ChatOptions {
    message: string
    sessionId?: string
    /** Optional channel ref for cross-channel session continuity. */
    channelRef?: { channel: string; channelId: string; chatId: string }
    sessionContext?: {
        activeView?: { type: string; id: string; summary: string }
        appState?: Record<string, unknown>
    }
}

export interface ChatReply {
    reply: string
    conversationId?: string
    sessionId?: string
    taskId?: string
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface PlexoConversation {
    id: string
    sessionId: string
    message: string
    reply: string | null
    createdAt: string
    source: string
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemoryEntry {
    id: string
    workspaceId: string
    content: string
    type?: string
    metadata?: Record<string, unknown>
    createdAt: string
}

export interface StoreMemoryOptions {
    content: string
    type?: 'pattern' | 'fact' | 'note' | string
    metadata?: Record<string, unknown>
}

export interface MemorySearchResult {
    id: string
    score?: number
    content?: string
    metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Graph (SDK 1.1.0 — Plexo Graphiti integration)
// ---------------------------------------------------------------------------

export interface AddEpisodeOptions {
    /** Free-form content extracted into the workspace's knowledge graph. */
    content: string
    /** Display name for the episode. Defaults to a derived name. */
    name?: string
    /** Provenance string. Defaults to `app:<appId>|src:sdk` server-side. */
    sourceDescription?: string
    /** ISO-8601 reference time for bi-temporal placement. Defaults to server now(). */
    referenceTime?: string
    /** Free-form metadata threaded into the underlying episode. */
    metadata?: Record<string, unknown>
}

export interface AddEpisodeResult {
    episodeId: string | null
    extractedFactsCount: number
    extractedNodesCount: number
}

export interface FactSearchResult {
    uuid: string | null
    fact: string | null
    sourceNodeUuid: string | null
    targetNodeUuid: string | null
    validAt: string | null
    invalidAt: string | null
    createdAt: string | null
}

export interface OcrResult {
    text: string
    confidence: number
    model: string
}

// ---------------------------------------------------------------------------
// Tools — gmessages sync invoke (SDK 1.2.0 — Levio↔gmessages bridge)
// ---------------------------------------------------------------------------

export interface GmessagesSendOptions {
    workspaceId: string
    /** libgm thread id. Use one of threadId or phoneE164. */
    threadId?: string
    /**
     * E.164 phone number for outbound resolution. NOT YET IMPLEMENTED — the
     * sidecar does not surface a phone→thread lookup; supplying phoneE164
     * without threadId returns 501 PHONE_LOOKUP_NOT_IMPLEMENTED. Use
     * `listThreads()` first to obtain the threadId. Kept in the type for
     * forward-compatibility.
     */
    phoneE164?: string
    text: string
}

export interface GmessagesSendResult {
    messageId: string
    deliveryStatus: 'accepted' | string
}

export interface GmessagesListThreadsOptions {
    workspaceId: string
    /** Reserved — not yet honored server-side (no phone↔thread index). */
    phoneE164?: string
    /** 1–100, default 25. */
    limit?: number
}

export interface GmessagesThreadParticipant {
    phone: string | null
    name: string | null
}

export interface GmessagesLastMessage {
    text: string
    direction: 'inbound' | 'outbound'
    sentAt: string
}

export interface GmessagesThread {
    threadId: string
    /**
     * Always `[]` in 1.2.0 — gmessages schema has no per-thread participant
     * table yet and libgm does not surface participant lists through the
     * sidecar. Kept for forward-compatibility; consumers must not depend on
     * this being populated until the gap is closed.
     */
    participants: GmessagesThreadParticipant[]
    lastMessage: GmessagesLastMessage
    /** Always 0 in 1.2.0 — read state is not tracked in `conversations`. */
    unreadCount: number
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Outbound event from app → Plexo Core node-events stream. */
export interface PublishEventOptions {
    eventType: string
    payload: Record<string, unknown>
    workspaceId?: string
}

// ---------------------------------------------------------------------------
// Channel dispatch
// ---------------------------------------------------------------------------

export interface DispatchOptions {
    channel: 'email' | 'push' | 'sms' | 'telegram' | string
    recipientUserId: string
    message: {
        subject?: string
        text: string
        attachments?: unknown[]
        metadata?: Record<string, unknown>
    }
    idempotencyKey: string
    scopeOverrides?: Record<string, unknown>
}

/** Optional dispatch context — adds tenancy/trace headers when provided. */
export interface DispatchContext {
    tenantId?: string
    workspaceId?: string
    userId?: string
    traceId?: string
}

export interface DispatchResult {
    messageId?: string
    deliveryStatus?: string
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface AppProfile {
    appId: string
    schemaNamespace: string
    displayName: string
    domain: string
    extensions: AppExtension[]
    eventContracts: string[]
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export type InboundEventType =
    | 'connection.connected'
    | 'connection.disconnected'
    | 'connection.error'
    | 'task.created'
    | 'task.updated'
    | 'task.completed'
    | 'workspace.updated'
    | string

export interface InboundEvent {
    type: InboundEventType
    workspaceId: string
    userId?: string
    payload: Record<string, unknown>
    timestamp: string
}

export interface DataQuery {
    tool: string
    workspaceId: string
    userId: string
    params: Record<string, unknown>
    requestId: string
}

export interface DataResponse {
    requestId: string
    result?: unknown
    error?: string
}

export interface InboundHandlers {
    onEvent?: (event: InboundEvent) => void | Promise<void>
    onDataQuery?: (query: DataQuery) => Promise<unknown>
}

export interface InboundVerifyResult {
    ok: boolean
    error?: string
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export interface TestConnectionResult {
    ok: boolean
    latencyMs: number
    plexoVersion?: string
    error?: string
}
