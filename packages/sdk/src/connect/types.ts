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
    /**
     * PEX contract version this client speaks. Defaults to PEX_CONTRACT_VERSION.
     * connect() negotiates to a common major with the server (ADR 0001 §5).
     */
    contractVersion?: string
    /**
     * Profile this app requests at connect() (ADR 0001 §3). Advisory — the
     * effective profile is intersection(requested, operator-granted). May also
     * be passed per-call to connect().
     */
    requestedProfile?: ConnectProfile
    /**
     * Resolution-ladder rung 2 (reuse-running): path to a local Plexo instance
     * descriptor lockfile. Only consulted when no plexoUrl is configured.
     * Defaults to $XDG_RUNTIME_DIR/plexo/instance.json (or /tmp fallback).
     */
    instanceDescriptorPath?: string
    /**
     * Resolution-ladder rung 3 (launch-local) seam. When no configured URL and
     * no running instance is found, connect() calls this to spawn/obtain a local
     * Plexo and returns its base URL. Hosts that support full launch-local
     * (desktop topology) provide it; the single-writer guard (OS file-lock + PG
     * advisory lock, attach-on-lose) is the launcher's responsibility. When
     * omitted, connect() fails loud with PlexoUnreachableError.
     */
    launchLocal?: () => Promise<string>
}

// ---------------------------------------------------------------------------
// ADR 0001 — Connection & Profile Standard (connect handshake)
// ---------------------------------------------------------------------------

/** A profile an app requests, or is granted (ADR 0001 §3). */
export interface ConnectProfile {
    connectors: string[]
    capabilities: string[]
}

/**
 * Local Plexo instance descriptor for rung-2 "reuse-running" discovery
 * (ADR 0001 §1). Written by a running local Plexo at an OS-conventional path.
 */
export interface LocalInstanceDescriptor {
    url: string
    pid?: number
    contractVersion?: string
    startedAt?: string
}

/** The negotiated session connect() returns. */
export interface NegotiatedSession {
    /** Resolved base URL the client attached to. */
    url: string
    /** How the URL was resolved (which ladder rung). */
    via: 'configured' | 'reuse-running' | 'launch-local'
    /** The server's PEX contract version. */
    serverContractVersion: string
    /** Grant status for this app×workspace. 'unscoped' = no workspace negotiated. */
    status: 'granted' | 'pending' | 'revoked' | 'unscoped'
    /** Effective profile = intersection(requested, granted). Empty unless granted. */
    effectiveProfile: ConnectProfile
}

/** Options for a single connect() call. */
export interface ConnectOptions {
    /** Negotiate a per-workspace profile during connect (ADR 0001 §3). */
    workspaceId?: string
    /** Profile to request; overrides PlexoClientOptions.requestedProfile. */
    requestedProfile?: ConnectProfile
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

// ---------------------------------------------------------------------------
// EP1: runCustom — multi-step agent loop with caller-provided prompt + tools
// ---------------------------------------------------------------------------

export interface RunCustomTool {
    /** Tool name surfaced to the LLM. Must be `[a-zA-Z0-9_]{1,64}`. */
    name: string
    /** Plain-English purpose. Influences when the LLM chooses this tool. */
    description: string
    /**
     * JSON Schema describing tool input. Plexo validates the LLM's call against this
     * before dispatching; failures are surfaced as tool errors back to the LLM.
     */
    inputSchema: Record<string, unknown>
    /**
     * Plexo POSTs `{ runId, toolName, input }` here when the LLM calls this tool.
     * Caller's handler must respond with `{ output: <string|json> }` within 30s.
     * Signed with per-run JWT (HS256, claims: workspaceId/runId/allowedTools).
     */
    callbackUrl: string
}

export interface RunCustomOptions {
    /** Free-form system prompt; replaces any built-in agent prompt for this run. */
    systemPrompt: string
    /** Caller-provided tools. Plexo dispatches via HTTP callback per `RunCustomTool.callbackUrl`. */
    tools: RunCustomTool[]
    /** Initial user-turn input to the agent loop. */
    input: string
    /** Optional model override. Defaults to workspace primary model. */
    model?: string
    /** Hard cap on agent loop iterations. Default 12. */
    maxSteps?: number
    /**
     * EP2: when true, Plexo registers a `read_memory` tool alongside caller tools.
     * Body shape: `{ query: string, limit?: number, tags?: string[] }` → `MemoryEntry[]`.
     */
    enableMemoryTool?: boolean
}

export interface RunCustomStep {
    /** Tool name invoked, if any. Absent on final assistant text turn. */
    tool?: string
    /** Input that was passed to the tool. */
    input?: Record<string, unknown>
    /** Tool output (string or JSON, as returned by callback). */
    output?: unknown
    /** Free-form error if the tool call failed. */
    error?: string
}

export interface RunCustomResult {
    /** Server-issued run identifier. Stable across the agent loop; tied to JWT claims. */
    runId: string
    /** Final assistant message after the loop terminated. */
    output: string
    /** Ordered transcript of tool dispatches + outputs. Empty if LLM responded directly. */
    steps: RunCustomStep[]
    /** True if `maxSteps` cap was hit before the LLM declared done. */
    truncated: boolean
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
// Unified analyze-image — SDK 1.4.0 (Plexo Core endpoint
// POST /api/v1/vision/analyze-image; see Fonto ADR 0002).
// Collapses 5 LLM calls (classify + label + ocr + describe + suggest-tags)
// into one structured response. Caller passes a presigned imageUrl and
// optional grounding hints (CLIP top class, EXIF flags, dimensions).
// ---------------------------------------------------------------------------

export interface AnalyzeImageHints {
    /** CLIP's top class (lowercase taxonomy key) — used as a soft prior. */
    topClipClass?: string
    /** CLIP's top-1 cosine score, [0..1]. */
    clipConfidence?: number
    /** EXIF camera-make string ("Apple", "Google", etc.). Used as a soft signal. */
    cameraMake?: string
    /** True if any positive camera-evidence EXIF field (exposureTime, fNumber, iso, focalLength) is set. */
    hasExposureExif?: boolean
    widthPx?: number
    heightPx?: number
}

export interface AnalyzeImageOptions {
    workspaceId: string
    /** Presigned (http/https) URL the model can fetch. */
    imageUrl: string
    /** Mime type — used only for the prompt hint. */
    mimeType?: string
    /** Filename — used only for the prompt hint. */
    filename?: string
    /** Optional grounding hints. */
    hints?: AnalyzeImageHints
}

export interface AnalyzeImageResult {
    /** Top-level taxonomy key (matches fonto's TAXONOMY top-keys). */
    classification:
        | 'photo' | 'document' | 'screenshot' | 'logo' | 'mockup' | 'icon'
        | 'sticker' | 'clipart' | 'meme' | 'art' | 'cover-art' | 'wallpaper'
        | 'diagram' | 'whiteboard'
    /** Slug-cased child label (e.g. 'portrait', 'receipt'). null if unsure. */
    subClassification: string | null
    /** Overall confidence in classification + sub-classification, [0..1]. */
    confidence: number
    /** Caption — 1-3 sentences, max ~60 words. */
    description: string
    /** Verbatim transcription of visible text. null if no text. */
    ocrText: string | null
    /** Salient object/scene labels (lowercase nouns). */
    labels: string[]
    /** User-facing tag names (title-case). */
    suggestedTags: string[]
    /** Model id used (for telemetry). */
    model: string
    /** End-to-end latency on the server side, ms. */
    latencyMs: number
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
