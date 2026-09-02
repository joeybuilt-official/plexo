// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Persistence ports for the `tasks/` use cases (architecture burn-down Stage 2).
 *
 * The drizzle adapter (`tasks.repository.ts`) is the only place that touches the
 * ORM for these flows. Ports express intent — never a `sql` passthrough, never a
 * drizzle row — so a storage swap does not reach the use case.
 */

import type { TaskStatus } from '@plexo/db'
import type { FailureReason } from './tasks/types.js'

// Re-exported so `tasks/terminal-fail.ts` can keep `TaskStatus` in its public
// input type without importing `@plexo/db` itself.
export type { TaskStatus }

// ── Artifact shares ─────────────────────────────────────────────────────────

export interface ArtifactShareInsert {
    id: string
    artifactId: string
    workspaceId: string
    createdBy: string
    visibility: 'unlisted' | 'public'
}

export interface ArtifactShareStore {
    /** The id of the artifact's active (non-revoked) share, or null. */
    findActiveShareId(artifactId: string): Promise<string | null>
    /** Insert a share, doing nothing when one already wins the active-share index. */
    insertShareIfAbsent(share: ArtifactShareInsert): Promise<void>
}

// ── Terminal task failure ───────────────────────────────────────────────────

export interface MarkTaskFailedFields {
    taskId: string
    failureReason: FailureReason
    /** Rendered user-facing outcome summary written to `outcome_summary`. */
    outcomeSummary: string
    /** Only transition when the task is currently in this status (optional guard). */
    requireFromStatus?: TaskStatus
}

export interface MarkTaskFailedOutcome {
    /** True when the row was actually updated (guard matched). */
    transitioned: boolean
    /** The failed task's parent id, or null. */
    parentTaskId: string | null
}

export interface TaskFailStore {
    /**
     * Transition a task to `failed` with structured metadata (`failed_at` set by
     * the adapter), clearing the claim, honoring the optional status guard.
     */
    markFailed(fields: MarkTaskFailedFields): Promise<MarkTaskFailedOutcome>
}
