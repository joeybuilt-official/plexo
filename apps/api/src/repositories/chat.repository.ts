// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Webchat data-access repository.
 *
 * owns the raw table reads behind the chat routes: the
 * model-knowledge consultative-routing lookups, the workspace task-status
 * snapshot, and the task / task-steps / sprint projections that drive the
 * reply long-poll and the live progress SSE stream. The route keeps all of the
 * AI/conversation logic — intent classification, provider calls, SSE emits,
 * recordConversation, trackEvent/trackError/audit, embeddings, the nameProject
 * call + runSprint orchestration, and the progress-event projection math. Only
 * the SQL moves here. Workspace lookups reuse workspaces.repository and sprint
 * inserts reuse sprints.repository (createSprint).
 */
import { db, eq, and, desc, sql } from '@plexo/db'
import { tasks, taskSteps, sprints, sprintTasks, sprintLogs, modelsKnowledge } from '@plexo/db'

/** Model-knowledge row for a model id, or undefined (consultative routing). */
export async function getModelKnowledge(modelId: string) {
    const [kbEntry] = await db.select().from(modelsKnowledge)
        .where(eq(modelsKnowledge.modelId, modelId))
        .limit(1)
    return kbEntry
}

/** Highest-reliability model whose strengths include "reasoning", or undefined. */
export async function getBestReasoningModel() {
    const [betterMatch] = await db.select().from(modelsKnowledge)
        .where(sql`${modelsKnowledge.strengths} @> '["reasoning"]'::jsonb`)
        .orderBy(desc(modelsKnowledge.reliabilityScore))
        .limit(1)
    return betterMatch
}

/** Task counts grouped by status for a workspace (numeric count). */
export async function getTaskStatusCounts(workspaceId: string): Promise<Array<{ status: string; count: number }>> {
    return db
        .select({ status: tasks.status, count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.workspaceId, workspaceId))
        .groupBy(tasks.status)
}

/** {status,outcomeSummary} for the reply long-poll, or undefined. */
export async function getTaskReplyStatus(taskId: string) {
    const [task] = await db.select({
        status: tasks.status,
        outcomeSummary: tasks.outcomeSummary,
    }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
    return task
}

/** Task fields needed by the progress-stream tick, or undefined. */
export async function getTaskTickFields(taskId: string) {
    const [task] = await db.select({
        status: tasks.status,
        outcomeSummary: tasks.outcomeSummary,
        createdAt: tasks.createdAt,
        projectId: tasks.projectId,
        plan: tasks.plan,
    }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
    return task
}

/** Latest task-step {stepNumber,outcome} for progress detail, or undefined. */
export async function getLatestStep(taskId: string) {
    const [latestStep] = await db.select({
        stepNumber: taskSteps.stepNumber,
        outcome: taskSteps.outcome,
    }).from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(desc(taskSteps.stepNumber))
        .limit(1)
    return latestStep
}

/** All task-step rows for the progress projection, oldest-first (cap 200). */
export async function getStepRows(taskId: string) {
    return db.select({
        stepNumber: taskSteps.stepNumber,
        toolCalls: taskSteps.toolCalls,
        outcome: taskSteps.outcome,
        isTerminal: taskSteps.isTerminal,
        stepState: taskSteps.stepState,
        state: taskSteps.state,
        createdAt: taskSteps.createdAt,
    }).from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(taskSteps.stepNumber)
        .limit(200)
}

/** Sprint counters for the chat agent-activity projection, or undefined. */
export async function getSprintProjection(sprintId: string) {
    const [sp] = await db.select({
        id: sprints.id,
        request: sprints.request,
        totalTasks: sprints.totalTasks,
        completedTasks: sprints.completedTasks,
        failedTasks: sprints.failedTasks,
    }).from(sprints).where(eq(sprints.id, sprintId)).limit(1)
    return sp
}

/** Sub-agent (sprint_task) rows for the chat activity panel, by priority (cap 40). */
export async function getSprintSubTasks(sprintId: string) {
    return db.select({
        id: sprintTasks.id,
        description: sprintTasks.description,
        branch: sprintTasks.branch,
        status: sprintTasks.status,
        priority: sprintTasks.priority,
    }).from(sprintTasks)
        .where(eq(sprintTasks.sprintId, sprintId))
        .orderBy(sprintTasks.priority, sprintTasks.createdAt)
        .limit(40)
}

/** Most recent wave_start log metadata for a sprint, or undefined. */
export async function getLastWaveLog(sprintId: string) {
    const [lastWave] = await db.select({ metadata: sprintLogs.metadata })
        .from(sprintLogs)
        .where(and(eq(sprintLogs.sprintId, sprintId), eq(sprintLogs.event, 'wave_start')))
        .orderBy(desc(sprintLogs.createdAt))
        .limit(1)
    return lastWave
}
