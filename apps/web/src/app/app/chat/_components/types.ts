// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import type { PastedImage, PastedDocument } from '@web/lib/attachments'
import type { ProgressEvent } from './agent-thinking-panel'
import type { PlanProposalPlan } from './plan-card'

/**
 * WorkKind — canonical taxonomy for how an agent-produced work should render.
 * Mirrors `packages/db/src/work-kind.ts` on the server. Kept as a plain union
 * here to avoid a runtime import of `@plexo/db` from the browser bundle.
 */
export type WorkKind =
    | 'markdown'
    | 'instructions'
    | 'code'
    | 'html'
    | 'mockup'
    | 'json'
    | 'yaml'
    | 'table'
    | 'checklist'
    | 'image'
    | 'diagram'
    | 'chart'
    | 'config'
    | 'link-list'
    | 'file'

export interface TaskAsset {
    artifactId?: string
    filename: string
    bytes: number
    isText: boolean
    content: string | null
    version?: number
    url?: string
    /**
     * Legacy coarse classification persisted on the `artifacts.type` DB column.
     * Kept for back-compat with Phase 1 clients. Optional so filesystem-fallback
     * responses (which don't carry this field) stay backward compatible.
     */
    type?: 'markdown' | 'code' | 'diagram' | 'html' | 'image' | 'file'
    /**
     * Phase 2 — rich WorkKind taxonomy. The agent can declare this via
     * `write_asset({ kind })`; the API falls back to inference for pre-Phase-2
     * rows or filesystem-fallback responses. This is the canonical field the
     * renderer should dispatch on from Phase 3 onward.
     */
    kind?: WorkKind
    /**
     * Phase 2 — renderer hints (language, columns, previewMode, ...).
     * Free-form object mirroring `artifacts.meta`.
     */
    meta?: Record<string, unknown>
    updatedAt?: string | Date
}

/**
 * Phase 2 — "Work" is the external-facing name for TaskAsset. Keep a type
 * alias so future renderers can import it under the canonical name without
 * forcing a rename cascade right now.
 */
export type Work = TaskAsset

/**
 * Inline plan-proposal message rendered as a <PlanCard> in the transcript.
 * Discriminated by `kind === 'plan_proposal'`. Carries no `role`/`content`
 * because the card is the entire payload.
 */
export interface PlanProposalMessage {
    id: string
    kind: 'plan_proposal'
    taskId: string
    plan: PlanProposalPlan
    requiresApproval: boolean
    approvalId: string | null
    at: number
}

export type ChatMessage = Message | PlanProposalMessage

export function isPlanProposalMessage(m: ChatMessage): m is PlanProposalMessage {
    return (m as PlanProposalMessage).kind === 'plan_proposal'
}

export interface Message {
    id: string
    kind?: 'message'
    role: 'user' | 'agent'
    content: string
    images?: PastedImage[]
    docs?: PastedDocument[]
    taskId?: string
    status?: 'queued' | 'running' | 'complete' | 'failed' | 'pending' | 'confirm_action'
    intent?: 'TASK' | 'PROJECT' | 'CONVERSATION'
    actionDescription?: string
    fixUrl?: string
    fixLabel?: string
    technicalDetail?: string
    model?: string
    assets?: TaskAsset[]
    steps?: Array<{
        id: string
        label: string
        icon?: string
        status: 'running' | 'complete' | 'failed'
    }>
    phases?: Array<{
        index: number
        total: number
        label: string
        status: 'pending' | 'running' | 'complete'
    }>
    currentPhase?: string
    /**
     * Compact accepted-plan summary streamed on each reply-stream tick while
     * the task runs. Renders a "Plan" header in the running bubble so a single
     * long step shows WHAT is being built (goal + steps + capability tags)
     * instead of a bare "Thinking…" timer. Distinct from PlanProposalMessage's
     * `plan` (which is the pre-execution approval card).
     */
    livePlan?: {
        goal?: string
        confidenceScore?: number
        steps: Array<{ n: number; description: string; capability?: string }>
    }
    /**
     * Live progress events emitted by the agent executor via the
     * /api/chat/reply-stream/:taskId SSE tick. Drives the
     * <AgentThinkingPanel>. Each tick sends the cumulative array; the
     * client replaces the message-level copy wholesale.
     */
    progressEvents?: ProgressEvent[]
    /**
     * Sprint / sub-agent activity, present when this chat task fanned out into a
     * multi-agent sprint. Sent on each reply-stream tick; drives the
     * <AgentActivityPanel>. Undefined for single-agent tasks.
     */
    sprint?: SprintActivity
    /** Accumulated model chain-of-thought for this turn (reasoning-delta concat). */
    reasoning?: string
    /** Live tool-call activity for this turn, matched by toolCallId. */
    toolCalls?: Array<{
        id: string
        toolName: string
        input?: unknown
        output?: unknown
        error?: string
        status: 'running' | 'done' | 'error'
    }>
    at: number
}

export interface SprintSubAgent {
    id: string
    description: string
    branch: string
    status: string   // queued | running | complete | failed | blocked | ...
    priority: number
}

export interface SprintActivity {
    id: string
    request: string
    totalTasks: number
    completedTasks: number
    failedTasks: number
    currentWave?: { index: number; total: number }
    subAgents: SprintSubAgent[]
}
