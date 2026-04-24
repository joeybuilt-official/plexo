// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { PastedImage, PastedDocument } from '@web/lib/attachments'
import type { ProgressEvent } from './agent-thinking-panel'

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

export interface Message {
    id: string
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
     * Live progress events emitted by the agent executor via the
     * /api/chat/reply-stream/:taskId SSE tick. Drives the
     * <AgentThinkingPanel>. Each tick sends the cumulative array; the
     * client replaces the message-level copy wholesale.
     */
    progressEvents?: ProgressEvent[]
    at: number
}
