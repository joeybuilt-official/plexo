// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for `executor/` persistence ports (Stage 2). The only
 * executor-area module permitted to import the ORM.
 */

import { db, taskSteps } from '@plexo/db'
import { eq, desc } from 'drizzle-orm'
import type { TaskStepStore, TaskStepRow } from './executor.ports.js'

export class DrizzleTaskStepStore implements TaskStepStore {
    async getLastStep(taskId: string): Promise<{ stepNumber: number; isTerminal: boolean } | null> {
        const [row] = await db.select({ stepNumber: taskSteps.stepNumber, isTerminal: taskSteps.isTerminal })
            .from(taskSteps)
            .where(eq(taskSteps.taskId, taskId))
            .orderBy(desc(taskSteps.stepNumber))
            .limit(1)
        return row ?? null
    }

    async listSteps(taskId: string): Promise<TaskStepRow[]> {
        const rows = await db.select({
            stepNumber: taskSteps.stepNumber,
            stepState: taskSteps.stepState,
            isTerminal: taskSteps.isTerminal,
        })
            .from(taskSteps)
            .where(eq(taskSteps.taskId, taskId))
            .orderBy(taskSteps.stepNumber)
        return rows.map(r => ({
            stepNumber: r.stepNumber,
            stepState: r.stepState as { responseMessages?: unknown[] } | null,
            isTerminal: r.isTerminal,
        }))
    }
}
