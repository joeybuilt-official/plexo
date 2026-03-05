/**
 * Sprint planner — given a repo + request, produces a list of SprintTask
 * records that can be executed in parallel with dependency ordering.
 */
import { generateObject } from 'ai'
import { z } from 'zod'
import pino from 'pino'
import { db, eq } from '@plexo/db'
import { sprints, sprintTasks } from '@plexo/db'
import { resolveModelFromEnv } from '../providers/registry.js'
import { MODEL_ROUTING } from '../constants.js'
import { categoryPlannerPrompt } from './categories.js'

const logger = pino({ name: 'sprint-planner' })

// ── Types ────────────────────────────────────────────────────────────────────

export interface SprintTask {
    id: string        // local id within plan (e.g. "t1") — NOT db id
    description: string
    scope: string[]   // paths the task may touch
    acceptance: string
    branch: string
    priority: number
    depends_on: string[]
}

export interface SprintPlan {
    tasks: SprintTask[]
    parallelism_note?: string
}

export interface PlanResult {
    sprintId: string
    tasks: Array<SprintTask & { dbId: string }>
    executionOrder: string[][] // waves of parallel tasks (by local id)
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SprintTaskSchema = z.object({
    id: z.string(),
    description: z.string(),
    scope: z.array(z.string()),
    acceptance: z.string(),
    branch: z.string(),
    priority: z.number(),
    depends_on: z.array(z.string()),
})

const SprintPlanSchema = z.object({
    tasks: z.array(SprintTaskSchema).max(8),
    parallelism_note: z.string().optional(),
})

// ── Planner ───────────────────────────────────────────────────────────────────

export async function planSprint(params: {
    sprintId: string
    workspaceId: string
    repo?: string          // undefined for non-code categories
    request: string
    contextFiles?: string[]
    category?: string      // defaults to 'code'
}): Promise<PlanResult> {
    const { sprintId, workspaceId, repo, request, contextFiles = [], category = 'code' } = params

    logger.info({ sprintId, repo, category }, 'Sprint planning started')

    const model = resolveModelFromEnv(MODEL_ROUTING.planning)

    const systemPrompt = categoryPlannerPrompt(category)

    const userMessage = [
        repo ? `Repository: ${repo}` : null,
        `Request: ${request}`,
        contextFiles.length > 0 ? `\nKey files:\n${contextFiles.slice(0, 50).join('\n')}` : null,
    ].filter((s): s is string => s !== null).join('\n')

    let rawPlan: SprintPlan
    try {
        const result = await generateObject({
            model,
            schema: SprintPlanSchema,
            system: systemPrompt,
            prompt: userMessage,
        })
        rawPlan = result.object
    } catch (err) {
        logger.error({ err, sprintId }, 'Sprint planner LLM call failed')
        throw new Error(`Sprint planning failed: ${(err as Error).message}`)
    }

    if (!Array.isArray(rawPlan.tasks) || rawPlan.tasks.length === 0) {
        throw new Error('Sprint planner returned no tasks')
    }

    // Cap at 8 tasks and substitute {sprintId} placeholder
    const tasks = rawPlan.tasks.slice(0, 8).map((t, i) => ({
        ...t,
        branch: t.branch.replace('{sprintId}', sprintId),
        priority: t.priority ?? (i + 1),
        depends_on: t.depends_on ?? [],
    }))

    // Persist sprint_tasks rows
    const insertedRows = await persistSprintTasks(sprintId, tasks)

    // Update sprint total_tasks count
    await db.update(sprints).set({ totalTasks: insertedRows.length }).where(eq(sprints.id, sprintId))

    // Build execution order (topological sort into parallel waves)
    const executionOrder = buildExecutionOrder(tasks)

    logger.info({ sprintId, taskCount: insertedRows.length, waves: executionOrder.length }, 'Sprint plan complete')

    return { sprintId, tasks: insertedRows, executionOrder }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function persistSprintTasks(
    sprintId: string,
    tasks: SprintTask[],
): Promise<Array<SprintTask & { dbId: string }>> {
    const results: Array<SprintTask & { dbId: string }> = []

    for (const task of tasks) {
        const dbId = crypto.randomUUID()
        await db.insert(sprintTasks).values({
            id: dbId,
            sprintId,
            description: task.description,
            scope: task.scope,
            acceptance: task.acceptance,
            branch: task.branch,
            priority: task.priority,
            status: 'queued',
        })
        results.push({ ...task, dbId })
    }

    return results
}

/**
 * Topological sort → execution waves.
 * Tasks in the same wave are independent and can run in parallel.
 */
function buildExecutionOrder(tasks: SprintTask[]): string[][] {
    const idSet = new Set(tasks.map((t) => t.id))
    const resolved = new Set<string>()
    const waves: string[][] = []
    let remaining = [...tasks]

    while (remaining.length > 0) {
        const wave = remaining.filter((t) =>
            t.depends_on.every((dep) => !idSet.has(dep) || resolved.has(dep)),
        )

        if (wave.length === 0) {
            // Cycle — dump the rest as one wave
            waves.push(remaining.map((t) => t.id))
            break
        }

        waves.push(wave.map((t) => t.id))
        for (const t of wave) resolved.add(t.id)
        remaining = remaining.filter((t) => !resolved.has(t.id))
    }

    return waves
}
