// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plain-English string mappings for the Work detail Lifecycle Timeline +
 * Verify Section (Phase F2).
 *
 * The agent loop writes terse machine event names and status enums into
 * `plexo_ops_task_events`. This module turns those into labels a user with
 * no codebase knowledge can scan in two seconds.
 *
 * Sibling helpers:
 *   - `apps/web/src/lib/plan-step-copy.ts` (Phase F1) — plan step namespace
 *   - `humanizeOperation` in `apps/web/src/app/app/approvals/page.tsx`
 *     (Phase D) — operation namespace
 * Keep them separate; they describe different things.
 */

export interface EventTypeCopy {
    label: string
    description?: string
}

const EVENT_TYPE_COPY: Record<string, EventTypeCopy> = {
    claimed: {
        label: 'Picked up by worker',
        description: 'A worker took the job from the queue.',
    },
    planning: {
        label: 'Planning',
        description: 'Working out how to approach the task.',
    },
    plan_proposed: {
        label: 'Plan proposed',
        description: 'A plan is ready for review.',
    },
    executing: {
        label: 'Working on it',
        description: 'Carrying out the plan.',
    },
    complete: {
        label: 'Finished',
    },
    failed: {
        label: 'Failed',
        description: 'The task could not be completed.',
    },
    blocked: {
        label: 'Blocked',
        description: 'Waiting on more information before continuing.',
    },
    requeued: {
        label: 'Re-queued for another try',
    },
    claim_timeout: {
        label: 'Worker stopped responding — re-queued',
    },
    ghost_recovery: {
        label: 'Recovered from a stuck worker',
    },
    manual_requeue: {
        label: 'Re-queued by you',
    },
    manual_cancel: {
        label: 'Cancelled by you',
    },
    wall_clock_exceeded: {
        label: 'Took too long — stopped',
    },
    awaiting_approval: {
        label: 'Waiting for your approval',
    },
    approval_granted: {
        label: 'You approved',
    },
    approval_rejected: {
        label: 'You rejected',
    },
    approval_timeout: {
        label: 'Approval window expired',
    },
    resumed: {
        label: 'Resumed after approval',
    },
}

const STATUS_LABELS: Record<string, string> = {
    queued: 'Queued',
    claimed: 'Picked up',
    running: 'Working',
    complete: 'Finished',
    failed: 'Failed',
    blocked: 'Blocked',
    cancelled: 'Cancelled',
    awaiting_approval: 'Waiting for approval',
}

function titleCase(raw: string): string {
    return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/** Plain-English label (and optional sub-label) for a task event_type. */
export function humanizeEventType(eventType: string): EventTypeCopy {
    return EVENT_TYPE_COPY[eventType] ?? { label: titleCase(eventType) }
}

/** Plain-English label for a task status enum value. */
export function humanizeTaskStatus(status: string): string {
    return STATUS_LABELS[status] ?? titleCase(status)
}

/**
 * Render a state transition like "Queued -> Picked up". Returns null when
 * both sides are absent or identical (no useful transition to show).
 */
export function humanizeStateTransition(
    fromState: string | null,
    toState: string | null,
): string | null {
    if (!fromState && !toState) return null
    if (fromState && toState && fromState === toState) return null
    if (!fromState && toState) return humanizeTaskStatus(toState)
    if (fromState && !toState) return humanizeTaskStatus(fromState)
    return `${humanizeTaskStatus(fromState as string)} → ${humanizeTaskStatus(toState as string)}`
}

/**
 * Relative time like "2 minutes ago", "yesterday", "3 days ago". Beyond
 * 30 days falls back to an absolute date so dates don't lose precision.
 */
export function formatRelativeTime(iso: string): string {
    const t = new Date(iso).getTime()
    if (!Number.isFinite(t)) return 'unknown'
    const diffMs = Date.now() - t
    if (diffMs < 0) return formatAbsoluteTime(iso)
    const seconds = Math.round(diffMs / 1000)
    if (seconds < 45) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 2) return '1 minute ago'
    if (minutes < 60) return `${minutes} minutes ago`
    const hours = Math.round(minutes / 60)
    if (hours < 2) return '1 hour ago'
    if (hours < 24) return `${hours} hours ago`
    const days = Math.round(hours / 24)
    if (days === 1) return 'yesterday'
    if (days <= 30) return `${days} days ago`
    return formatAbsoluteTime(iso)
}

/** Absolute timestamp like "May 3, 2026 at 2:14 PM". */
export function formatAbsoluteTime(iso: string): string {
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return 'unknown'
    const date = d.toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    })
    const time = d.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
    })
    return `${date} at ${time}`
}

/** Copy for the Verify Section placeholder when no verify data exists. */
export function verifyOutcomeCopy(): { heading: string; placeholderBody: string } {
    return {
        heading: 'Verification',
        placeholderBody:
            'No verification recorded for this answer. Plexo did not cross-check the result against external sources. If this answer matters, double-check before acting on it.',
    }
}
