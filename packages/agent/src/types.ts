// ── Task Types ────────────────────────────────────────────────

export type TaskType =
    | 'coding'
    | 'deployment'
    | 'research'
    | 'ops'
    | 'opportunity'
    | 'monitoring'
    | 'report'
    | 'online'
    | 'automation'

export type TaskStatus = 'queued' | 'claimed' | 'running' | 'complete' | 'blocked' | 'cancelled'
export type TaskSource = 'telegram' | 'scanner' | 'github' | 'cron' | 'dashboard' | 'api'

export interface Task {
    id: string
    workspaceId: string
    type: TaskType
    status: TaskStatus
    priority: number
    source: TaskSource
    project: string | null
    parentId: string | null
    context: Record<string, unknown>
    qualityScore: number | null
    confidenceScore: number | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    promptVersion: string | null
    outcomeSummary: string | null
    createdAt: Date
    claimedAt: Date | null
    completedAt: Date | null
}

export interface PushTaskParams {
    workspaceId: string
    type: TaskType
    source: TaskSource
    context: Record<string, unknown>
    priority?: number
    project?: string
    parentId?: string
    status?: TaskStatus
}

export interface CompleteTaskParams {
    qualityScore: number
    outcomeSummary: string
    deliverables: unknown[]
    tokensIn: number
    tokensOut: number
    costUsd: number
}

export interface TaskFilter {
    workspaceId?: string
    status?: TaskStatus | TaskStatus[]
    type?: TaskType
    source?: TaskSource
    project?: string
    limit?: number
    cursor?: string
}

// ── Execution Plan ───────────────────────────────────────────

export interface ExecutionPlan {
    taskId: string
    goal: string
    steps: PlanStep[]
    oneWayDoors: OneWayDoor[]
    estimatedDurationMs: number
    confidenceScore: number
    risks: string[]
}

export interface PlanStep {
    stepNumber: number
    description: string
    toolsRequired: string[]
    verificationMethod: string
    isOneWayDoor: boolean
}

export interface OneWayDoor {
    description: string
    type:
    | 'schema_migration'
    | 'public_api_change'
    | 'resource_deletion'
    | 'service_restart'
    | 'data_write'
    | 'external_publish'
    reversibility: string
    requiresApproval: true
}

// ── Sprint Types ─────────────────────────────────────────────

export interface SprintParams {
    workspaceId: string
    repo: string
    request: string
    maxWorkers?: number
}

export interface SprintStatus {
    id: string
    repo: string
    request: string
    status: string
    activeWorkers: number
    maxWorkers: number
    mergeQueueDepth: number
    plannerIteration: number
    tasksComplete: number
    tasksTotal: number
    costUsdSoFar: number
    elapsedMs: number
}

export interface SprintTask {
    id: string
    description: string
    scope: string[]
    acceptance: string
    branch: string
    priority: number
    dependsOn?: string[]
}

export interface Handoff {
    taskId: string
    status: 'complete' | 'partial' | 'blocked' | 'failed'
    summary: string
    filesChanged: string[]
    concerns: string[]
    suggestions: string[]
    metrics: {
        linesAdded: number
        linesRemoved: number
        tokensUsed: number
        toolCallCount: number
        durationMs: number
    }
    buildExitCode: number
}

// ── Memory Types ─────────────────────────────────────────────

export type MemoryType = 'task' | 'incident' | 'session' | 'pattern'

export interface MemoryEntry {
    workspaceId: string
    type: MemoryType
    content: string
    embedding?: number[]
    metadata: Record<string, unknown>
}

export interface MemorySearchOptions {
    workspaceId: string
    types?: MemoryType[]
    limit?: number
    minScore?: number
    includeGlobal?: boolean
}

export interface MemoryResult {
    id: string
    content: string
    type: MemoryType
    metadata: Record<string, unknown>
    score: number
    createdAt: Date
}

// ── Session / Channel Types ──────────────────────────────────

export interface Session {
    id: string
    channelId: string
    userId: string
    messages: Message[]
    createdAt: Date
}

export interface Message {
    id: string
    role: 'user' | 'agent'
    text: string
    sentAt: Date
    taskId?: string
    model?: string
    tokensUsed?: number
    senderName?: string
    channelMessageId?: string
}

export interface Channel {
    id: string
    workspaceId: string
    type: string
    name: string
    enabled: boolean
    lastMessageAt: Date | null
    errorCount: number
}

export interface AddChannelParams {
    workspaceId: string
    type: string
    name: string
    config: Record<string, unknown>
}

// ── Channel Adapter ──────────────────────────────────────────

export interface InboundMessage {
    id: string
    channelType: string
    senderId: string
    senderName: string
    text: string
    raw: unknown
    receivedAt: Date
}

export interface OutboundMessage {
    recipientId: string
    text: string
    actions?: Array<{ label: string; value: string }>
}

export interface ChannelAdapter {
    name: string
    connect(config: Record<string, unknown>): Promise<void>
    disconnect(): Promise<void>
    send(message: OutboundMessage): Promise<void>
    onMessage(handler: (msg: InboundMessage) => void): void
    onError(handler: (err: Error) => void): void
    healthCheck(): Promise<{ ok: boolean; detail?: string }>
}

// ── Error Types ──────────────────────────────────────────────

export type ErrorCategory = 'user' | 'system' | 'upstream'

// ── Notification Types ───────────────────────────────────────

export type NotificationType =
    | 'task_complete'
    | 'task_blocked'
    | 'sprint_complete'
    | 'alert_fired'
    | 'connection_error'
    | 'cost_alert'
    | 'rsi_proposal'
    | 'doc_updated'
    | 'confirmation_required'

export interface Notification {
    workspaceId: string
    type: NotificationType
    text: string
    action?: { label: string; url: string }
    channels?: string[]
    ttl?: number
}

// ── Tool Types ───────────────────────────────────────────────

export interface ToolCallContext {
    workspaceId: string
    taskId: string | null
    connectionId: string | null
}

export interface ToolResult {
    success: boolean
    output: unknown
    error?: string
    metadata?: {
        cost?: number
        latencyMs?: number
    }
}

// ── AI Provider Credentials ──────────────────────────────────
//
// AnthropicCredential is a discriminated union — either a standard API key
// or OAuth tokens from the claude.ai subscription flow. Both are supported
// transparently by resolveAnthropicHeaders() in ai/anthropic-oauth.ts.

export type AnthropicCredential =
    | { type: 'api_key'; apiKey: string }
    | {
        type: 'oauth_token'
        accessToken: string
        refreshToken: string
        /** Unix ms — token is refreshed proactively 60s before this */
        expiresAt: number
    }

// ── Execution Context ────────────────────────────────────────

export interface ExecutionContext {
    taskId: string
    workspaceId: string
    userId: string
    credential: AnthropicCredential
    /** Task type — used by the quality judge to select the correct rubric. */
    taskType: TaskType
    /** Max output tokens for generateText. 0 = no cap. */
    tokenBudget: number
    /** Max USD this task may spend. null = inherit workspace default. */
    taskCostCeilingUsd: number | null
    signal: AbortSignal
}

export interface StepResult {
    stepNumber: number
    ok: boolean
    output: string
    toolCalls: Array<{ tool: string; input: unknown; output: unknown }>
    tokensIn: number
    tokensOut: number
    costUsd: number
    durationMs: number
}

export interface ExecutionResult {
    taskId: string
    ok: boolean
    /** Short-circuit error message (OWD gate, cost ceiling, etc.) */
    error?: string
    /** Machine-readable code: OWD_REJECTED | OWD_TIMEOUT | COST_CEILING | etc. */
    errorCode?: string
    steps: StepResult[]
    outcomeSummary: string
    qualityScore: number
    totalTokensIn: number
    totalTokensOut: number
    totalCostUsd: number
    totalDurationMs: number
}

