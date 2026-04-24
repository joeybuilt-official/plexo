// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Conflict detection — static (scope-based) and dynamic (GitHub compare).
 */
import pino from 'pino'
import { db, eq } from '@plexo/db'
import { sprintTasks, sprints } from '@plexo/db'
import { buildGitHubClient } from '../github/client.js'

const logger = pino({ name: 'sprint-conflicts' })

export interface ConflictResult {
    taskA: string
    taskB: string
    branchA: string
    branchB: string
    conflictingFiles: string[]
}

// ── Static analysis (before execution) ───────────────────────────────────────

export function detectStaticConflicts(
    tasks: Array<{ id: string; scope: string[] }>,
): Array<{ taskA: string; taskB: string; overlap: string[] }> {
    const conflicts: Array<{ taskA: string; taskB: string; overlap: string[] }> = []

    for (let i = 0; i < tasks.length; i++) {
        for (let j = i + 1; j < tasks.length; j++) {
            const a = tasks[i]!
            const b = tasks[j]!
            const overlap = a.scope.filter((s) =>
                b.scope.some((t) => s.startsWith(t) || t.startsWith(s) || s === t),
            )
            if (overlap.length > 0) {
                conflicts.push({ taskA: a.id, taskB: b.id, overlap })
            }
        }
    }

    return conflicts
}

// ── Dynamic analysis (after execution, via GitHub compare) ───────────────────

export async function detectDynamicConflicts(
    sprintId: string,
    owner: string,
    repo: string,
    baseBranch: string,
): Promise<ConflictResult[]> {
    const github = buildGitHubClient(owner, repo)

    const dbTasks = await db.select({
        id: sprintTasks.id,
        branch: sprintTasks.branch,
        status: sprintTasks.status,
    }).from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))

    const completedTasks = dbTasks.filter((t) => t.status === 'complete' || t.status === 'failed')

    const changedFilesByTask: Map<string, { branch: string; files: string[] }> = new Map()

    await Promise.all(
        completedTasks.map(async (task) => {
            try {
                const diff = await github.compare(baseBranch, task.branch)
                changedFilesByTask.set(task.id, {
                    branch: task.branch,
                    files: diff.files?.map((f) => f.filename) ?? [],
                })
            } catch (err) {
                logger.warn({ err, branch: task.branch }, 'Could not compare branch for conflict detection')
            }
        }),
    )

    const conflicts: ConflictResult[] = []
    const taskIds = [...changedFilesByTask.keys()]

    for (let i = 0; i < taskIds.length; i++) {
        for (let j = i + 1; j < taskIds.length; j++) {
            const a = changedFilesByTask.get(taskIds[i]!)!
            const b = changedFilesByTask.get(taskIds[j]!)!
            const conflictingFiles = a.files.filter((f) => b.files.includes(f))

            if (conflictingFiles.length > 0) {
                conflicts.push({
                    taskA: taskIds[i]!,
                    taskB: taskIds[j]!,
                    branchA: a.branch,
                    branchB: b.branch,
                    conflictingFiles,
                })
            }
        }
    }

    if (conflicts.length > 0) {
        await db.update(sprints).set({ conflictCount: conflicts.length }).where(eq(sprints.id, sprintId))
        logger.warn({ sprintId, conflictCount: conflicts.length }, 'Sprint conflicts detected')
    }

    return conflicts
}
