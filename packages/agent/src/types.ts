// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// ── Task Types ────────────────────────────────────────────────

import type { TaskType, TaskStatus } from '@plexo/db'
export type { TaskType, TaskStatus }
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

// ── Deliverable Output Contract ──────────────────────────────

export interface TaskWork {
    type: 'file' | 'diff' | 'url' | 'data' | 'command'
    label: string
    content: string // path, URL, shell command, or inline content
}

export interface TaskDeliverable {
    summary: string
    outcome: 'completed' | 'partial' | 'blocked' | 'failed'
    works: TaskWork[]
    verificationSteps: string[]
}

export interface CompleteTaskParams {
    qualityScore: number
    outcomeSummary: string
    deliverables: unknown[]
    tokensIn: number
    tokensOut: number
    costUsd: number
    deliverable?: TaskDeliverable
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
    /**
     * Goal Lattice: execution waves derived from step dependency edges.
     * Each inner array contains step numbers that can run in parallel.
     * Populated by the planner when depends_on edges are present.
     */
    waves?: number[][]
    /** Structured phases for progress transparency. Planner may or may not produce them. */
    phases?: Array<{ index: number; label: string; description?: string }>
}

// ── Capability-aware planner output (Phase D) ─────────────────

export interface ClarificationAlternative {
    /** Short label for a button or chip, e.g. "Write a video script" */
    label: string
    /** One-sentence description of what will be delivered */
    description: string
    /** Full task description to queue if user picks this option */
    taskDescription: string
}

export interface ClarificationRequest {
    type: 'clarification'
    /** Human-readable message explaining the gap */
    message: string
    /** 1–4 alternatives the agent CAN deliver */
    alternatives: ClarificationAlternative[]
}

export type PlannerResult =
    | { type: 'plan'; plan: ExecutionPlan }
    | ClarificationRequest

export interface PlanStep {
    stepNumber: number
    description: string
    toolsRequired: string[]
    verificationMethod: string
    isOneWayDoor: boolean
    /**
     * Goal Lattice: step numbers this step depends on.
     * A step may only begin after all steps in depends_on are complete.
     * Empty or absent = no dependencies (can run in wave 0).
     */
    depends_on?: number[]
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
    | 'external_call'
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
    | 'task_awaiting_approval'
    | 'task_rejected'
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

// ── Step streaming events (Code Mode) ────────────────────────

export type StepEventType =
    | 'step.shell_line'
    | 'step.file_write'
    | 'step.screenshot'
    | 'step.test_result'
    | 'agent_step'
    | 'task_resumed'
    | 'routing_fallback'
    | 'provider_fallback_engaged'
    | 'cost_ceiling_warn'

export interface StepShellLineEvent {
    type: 'step.shell_line'
    taskId: string
    workspaceId: string
    label?: string   // 'ssh' | 'shell' | 'test'
    line: string
    ts: number
}

export interface StepFileWriteEvent {
    type: 'step.file_write'
    taskId: string
    workspaceId: string
    path: string     // relative to sprintWorkDir
    patch: string    // unified diff (empty string = new file)
    ts: number
}

export interface StepScreenshotEvent {
    type: 'step.screenshot'
    taskId: string
    workspaceId: string
    dataUrl: string  // base64 PNG
    label: string
    ts: number
}

export interface StepTestResultEvent {
    type: 'step.test_result'
    taskId: string
    workspaceId: string
    pass: boolean
    name: string
    detail: string
    ts: number
}

export interface StepAgentStepEvent {
    type: 'agent_step'
    taskId: string
    workspaceId: string
    step: number
    ts: number
    /** Tool name the model chose for this step (set once generateText returns). */
    tool?: string
    /** Plain-English present-continuous description (e.g. "Checking your calendar"). */
    description?: string
}

/** Generic step event for lifecycle signals (resume, routing fallback, etc.) */
export interface StepGenericEvent {
    type: 'task_resumed' | 'routing_fallback' | 'provider_fallback_engaged' | 'cost_ceiling_warn'
    taskId: string
    workspaceId: string
    ts: number
    [key: string]: unknown
}

export type StepEvent =
    | StepShellLineEvent
    | StepFileWriteEvent
    | StepScreenshotEvent
    | StepTestResultEvent
    | StepAgentStepEvent
    | StepGenericEvent

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
    // ── Phase A: Workspace + sprint context ──────────────────────────────────
    /** Human-readable workspace name (e.g. "Angel") */
    workspaceName?: string
    /** Agent persona name (e.g. "Angel") — may differ from workspace name */
    agentName?: string
    /** Agent persona description injected before system prompt */
    agentPersona?: string
    /** Active sprint/project goal this task belongs to */
    sprintGoal?: string
    /** Active sprint/project name this task belongs to */
    sprintName?: string
    /** Brief description of the workspace purpose */
    workspaceSummary?: string
    /** Primary GitHub repository for this workspace (owner/repo), set in workspace settings */
    primaryRepo?: string
    // ── Runtime identity (set by agent-loop after provider resolution) ─────────
    /** The provider key actually executing this task, e.g. 'anthropic', 'openai' */
    activeProvider?: string
    /** The model ID actually in use, e.g. 'claude-sonnet-4-5' */
    activeModel?: string
    /**
     * Per-task model override ID — forces Mode 4 (Override) for this task only.
     * Set from task.context.modelOverrideId if present.
     * Overrides workspace inferenceMode and modelOverrides for all task types.
     */
    modelOverrideId?: string
    // ── Sprint coding context ─────────────────────────────────────────────────
    /** Absolute path to the cloned repo working directory for coding tasks */
    sprintWorkDir?: string
    /** Target repo (owner/repo) for coding sprint tasks */
    sprintRepo?: string
    /** Branch this sprint task is working on */
    sprintBranch?: string
    /** ID of the sprint this task belongs to, for analytics logging */
    sprintId?: string
    /**
     * Execution Priming: file paths whose content has been pre-loaded before execution.
     * Injected into the system prompt so the agent starts with repo context already loaded
     * rather than spending tool calls reading files it was already told to touch.
     * Populated from sprint_tasks.scope by agent-loop for coding tasks with a workdir.
     */
    scopeFiles?: Array<{ path: string; content: string }>
    /**
     * Code Mode: SSE stream callback. When set, the executor will emit
     * step events (shell lines, file writes, screenshots, test results)
     * to connected Code Mode clients in real time.
     * Intentionally optional — non-coding tasks leave this undefined.
     */
    emitStepEvent?: (event: StepEvent) => void
    /**
     * Code Mode: track which file is currently "active" in the editor.
     * Used to inject cursor context into chat message dispatch.
     */
    sprintActivePath?: string
    /**
     * Resolved Brave Search API key for this workspace.
     * Populated by the agent-loop from workspace.settings.search.braveApiKey (decrypted)
     * or falling back to the BRAVE_SEARCH_API_KEY environment variable.
     * The agent package never reads secrets directly — the API layer resolves and injects.
     */
    braveSearchApiKey?: string
    /**
     * Resolved Tavily API key for this workspace. Tavily is the preferred
     * web-search provider when configured — purpose-built for agents.
     * Populated by the agent-loop from workspace.settings.search.tavilyApiKey
     * or TAVILY_API_KEY env fallback.
     */
    tavilyApiKey?: string
    // ── SCL: Workspace Memory context ────────────────────────────────────────
    /** Expanded MindsetObject context — domain knowledge, patterns, suggested tools */
    sclContext?: {
        relevantPatterns: string[]
        suggestedTools: string[]
        domainKnowledge: string[]
        tokenCount: number
        sourceRegions: string[]
    }
    /**
     * Image URLs attached to the original user message (from any channel:
     * dashboard chat, Telegram photo, Slack image file, Discord attachment).
     * When set, the executor builds its first user message as multimodal
     * content parts (text + image) so the vision-capable model can see them.
     * Populated by agent-loop from task.context.imageUrls.
     */
    inputImageUrls?: string[]
    /** Source channel that submitted this task — used to mark external-channel tasks as untrusted input. */
    taskSource?: TaskSource
    /**
     * Connector allowlist for this task run.
     * When non-empty, only connections whose `installed_connections.id` appears
     * in this list will have their tools loaded. Connections outside the list
     * are excluded at the DB query level — their tools are completely unreachable.
     * When undefined (or empty), all active workspace connections are loaded.
     * Set from task.context.connectorIds (populated by cron-dispatch for routines
     * that have connector_ids configured).
     *
     * ⚠ SECURITY DECISION — empty-list behaviour:
     *   undefined  → allow all (default, backwards-compatible)
     *   ['id',…]   → allowlist: only listed connectors
     *   []         → treated as undefined (allow all) — an explicit empty list
     *               in context means "no restriction was specified", not "deny all".
     *               Rationale: cron-dispatch already omits connectorIds from context
     *               when the DB column is empty, so [] in context is unexpected.
     *               If future callers need "deny all connectors", use a sentinel
     *               value rather than [].
     */
    connectorIds?: string[]
    /**
     * FUN-014: Checkpoint resume — original task ID to rebuild message history from.
     * Set by the retry handler when re-queuing a blocked/failed task that has
     * persisted step states. The executor uses this to call buildResumeMessages()
     * against the original task's steps instead of starting from scratch.
     */
    resumeFromTaskId?: string
    /**
     * L5b (ADR 0006 §D5): callback fired when the executor-side outbound
     * approval guard intercepts a tool call that the planner-time elevation
     * pass did not cover. The agent layer cannot reach into apps/api metrics
     * without a layering violation, so the API layer wires this to
     * `incrementCounter('plexo_outbound_tool_call_uncovered_total', ...)`.
     */
    onOutboundUncovered?: (params: { tool: string; provider: string }) => void
    /**
     * L5.5 #8: fires once per (task, tool) pair when the per-task denial
     * budget exhausts. Wired by API layer to
     * `incrementCounter('plexo_outbound_denial_loop_total', ...)`.
     */
    onOutboundDenialLoop?: (params: { tool: string; provider: string; count: number }) => void
    /**
     * Phase N verification hook (double-gated). Only populated when env
     * `PLEXO_CAPABILITY_GAP_TEST === '1'` AND `task.context._capabilityGapTest`
     * is set. Forces the executor to throw a synthetic error so the
     * capability-gap complete-with-limitation / honest-fail paths can be
     * exercised end-to-end in prod without relying on the model emitting a
     * matching error organically. Inert in all normal operation (undefined).
     *   'with_deliverable' | 'no_deliverable' → capability-worded throw
     *   'crash'                                → non-matching throw (real crash)
     * The deliverable precondition itself is controlled by the harness
     * (presence/absence of an artifact row), not by this flag.
     */
    capabilityGapTest?: 'with_deliverable' | 'no_deliverable' | 'crash'
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
    /**
     * null = quality judge has not settled yet (it runs off the completion hot
     * path, ADR 0002 / Phase M). The score is async-patched onto the task row
     * when the judge resolves. Never fabricated.
     */
    qualityScore: number | null
    totalTokensIn: number
    totalTokensOut: number
    totalCostUsd: number
    totalDurationMs: number
}

