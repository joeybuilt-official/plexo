// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Progress event types — the primitive that every channel consumes.
 *
 * One source of truth, many renderings. Telegram gets a compact projection,
 * web gets a collapsible indicator, glass cockpit gets the full stream.
 * SCL reflection consumes phase events for continuity and learning.
 */

export type ProgressEventType =
    | 'phase_start'
    | 'phase_complete'
    | 'tool_call'
    | 'tool_result'
    | 'reasoning'
    | 'memory_commit'
    | 'learning'
    | 'error'
    | 'status'

export interface PhaseContext {
    /** 0-based index */
    index: number
    /** Total phases declared */
    total: number
    /** Human-readable label: "Writing migration", "Running tests" */
    label: string
}

export interface ToolContext {
    /** Tool name: "ssh__exec", "github__list_issues" */
    name: string
    /** Human-readable action: "Reading package.json", "Searching GitHub" */
    displayAction: string
    /** Safe-to-display subset of args (credentials stripped) */
    argsRedacted?: Record<string, unknown>
}

export interface ProgressEvent {
    /** Monotonic ID (ulid) */
    id: string
    /** Task this event belongs to */
    taskId: string
    /** Workspace for routing */
    workspaceId: string
    /** Event type */
    type: ProgressEventType
    /** Phase context (when the agent has declared a plan) */
    phase?: PhaseContext
    /** Tool context (for tool_call and tool_result types) */
    tool?: ToolContext
    /** Human-readable summary — ALWAYS present, NEVER empty */
    content: string
    /** Machine-readable detail (glass cockpit only, redacted for default view) */
    detail?: unknown
    /** Timestamp */
    timestamp: number
    /** Duration in ms (for tool_result: how long the tool took) */
    durationMs?: number
}

/**
 * Phase plan — declared by the planner or by a skill manifest.
 */
export interface PhaseDeclaration {
    index: number
    label: string
    description?: string
}

export interface PhasePlan {
    phases: PhaseDeclaration[]
}

/**
 * Projection density — controls how much of the event stream a channel sees.
 */
export type ProjectionDensity = 'compact' | 'normal' | 'verbose'

/**
 * Channel projection config.
 */
export interface ProjectionConfig {
    density: ProjectionDensity
    /** Which event types to include */
    includeTypes: Set<ProgressEventType>
    /** Max content length for the projected message */
    maxContentLength: number
}

/** Compact: phase transitions + errors only (Telegram, SMS, embedded) */
export const COMPACT_PROJECTION: ProjectionConfig = {
    density: 'compact',
    includeTypes: new Set(['phase_start', 'phase_complete', 'error', 'status']),
    maxContentLength: 200,
}

/** Normal: phases + tool calls + memory (web default) */
export const NORMAL_PROJECTION: ProjectionConfig = {
    density: 'normal',
    includeTypes: new Set(['phase_start', 'phase_complete', 'tool_call', 'tool_result', 'memory_commit', 'learning', 'error', 'status']),
    maxContentLength: 500,
}

/** Verbose: everything (glass cockpit) */
export const VERBOSE_PROJECTION: ProjectionConfig = {
    density: 'verbose',
    includeTypes: new Set(['phase_start', 'phase_complete', 'tool_call', 'tool_result', 'reasoning', 'memory_commit', 'learning', 'error', 'status']),
    maxContentLength: 2000,
}
