// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plain-English string mappings for the PlanCard component.
 *
 * The planner emits tool ids, one-way-door type ids, risk levels, durations
 * and confidence scores in machine-friendly form. This module turns those
 * into labels a user with no codebase knowledge can scan in two seconds.
 *
 * This file covers the *plan-step* namespace —
 * tool ids, OWD types, risks, duration, and confidence.
 */

export const PLAN_HEADING = 'Plan'
export const PLAN_PROCEED_LABEL = 'Proceed'
export const PLAN_REJECT_LABEL = 'Reject'
export const PLAN_AUTO_NOTE = 'Running automatically — no approval needed.'

const TOOL_LABELS: Record<string, string> = {
    bash: 'Run shell command',
    shell: 'Run shell command',
    run_bash: 'Run shell command',
    read_file: 'Read a file',
    write_file: 'Write a file',
    delete_file: 'Delete a file',
    edit_file: 'Edit a file',
    grep: 'Search inside files',
    glob: 'Find files by name',
    playwright: 'Control a web browser',
    web_fetch: 'Fetch a web page',
    web_read_page: 'Read a web page',
    web_search: 'Search the web',
    memory_query: 'Look up past work',
    get_repository_info: 'Look at the code repository',
    get_runtime_environment: 'Check the running environment',
    get_infrastructure: 'Check the infrastructure',
}

const OWD_TYPE_LABELS: Record<string, string> = {
    schema_migration: 'Change the database structure',
    public_api_change: 'Change a public API others depend on',
    resource_deletion: 'Delete something permanently',
    service_restart: 'Restart a running service',
    data_write: "Write data that can't easily be undone",
    external_publish: 'Publish to an outside service',
}

const RISK_LABELS: Record<string, string> = {
    low: 'Low risk',
    medium: 'Medium risk',
    high: 'High risk',
    critical: 'Critical risk',
}

function titleCase(raw: string): string {
    return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/** Plain-English label for a planner tool id. */
export function humanizeToolName(tool: string): string {
    return TOOL_LABELS[tool] ?? titleCase(tool)
}

/** Plain-English label for a one-way-door type id. */
export function humanizeOWDType(type: string): string {
    return OWD_TYPE_LABELS[type] ?? titleCase(type)
}

/** Plain-English label for a risk level. */
export function humanizeRiskLevel(risk: string): string {
    return RISK_LABELS[risk] ?? titleCase(risk)
}

/** Humanize a duration in milliseconds. */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown'
    const seconds = ms / 1000
    if (seconds < 60) return 'less than a minute'
    const minutes = seconds / 60
    if (minutes < 60) {
        const n = Math.max(1, Math.round(minutes))
        return `about ${n} min`
    }
    const hours = Math.max(1, Math.round(minutes / 60))
    return hours === 1 ? 'about 1 hour' : `about ${hours} hours`
}

/** Render a 0..1 confidence score as an integer percent. */
export function formatConfidence(score: number): string {
    if (!Number.isFinite(score)) return 'unknown confidence'
    const clamped = Math.max(0, Math.min(1, score))
    return `${Math.round(clamped * 100)}% confident`
}
