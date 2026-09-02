// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Persistence ports for `executor/` use cases (architecture burn-down Stage 2).
 *
 * The drizzle adapter (`executor.repository.ts`) is the only executor-area code
 * permitted to import the ORM. Later stages (Stage 4: `executor/index.ts`,
 * `quality-judge.ts`) extend this file rather than creating new ones.
 */

/** A persisted step record, as the resume logic needs it. */
export interface TaskStepRow {
    stepNumber: number
    stepState: { responseMessages?: unknown[] } | null
    isTerminal: boolean
}

export interface TaskStepStore {
    /** The newest persisted step for a task, or null when none exist. */
    getLastStep(taskId: string): Promise<{ stepNumber: number; isTerminal: boolean } | null>
    /** All persisted steps for a task, ordered by step number ascending. */
    listSteps(taskId: string): Promise<TaskStepRow[]>
}
