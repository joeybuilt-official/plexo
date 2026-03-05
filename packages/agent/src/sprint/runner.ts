/**
 * Sprint runner — orchestrates parallel execution of sprint tasks.
 *
 * Flow per sprint:
 * 1. planSprint() → ExecutionWaves (topological order)
 * 2. For each wave: execute tasks in parallel
 *    - Create branch from base
 *    - Push task to queue with sprint context
 *    - Wait for task completion (poll sprint_tasks.status)
 *    - Run CI wait
 *    - Create draft PR against base branch
 * 3. After all waves: run dynamic conflict detection
 * 4. Update sprint status (complete / partial)
 * 5. Emit SSE event for dashboard
 *
 * The runner does NOT execute code itself — it delegates to the existing
 * agent executor via the task queue. Each sprint task becomes a regular
 * task with `type: 'coding'` and sprint context in its context payload.
 */
import pino from 'pino'
import { db, eq, inArray, and, isNotNull, sql } from '@plexo/db'
import { sprints, sprintTasks, tasks } from '@plexo/db'
import { push as pushTask } from '@plexo/queue'
import { planSprint, type PlanResult } from './planner.js'
import { detectStaticConflicts, detectDynamicConflicts } from './conflicts.js'
import { buildGitHubClient } from '../github/client.js'

const logger = pino({ name: 'sprint-runner' })

const TASK_POLL_MS = 5_000
const TASK_TIMEOUT_MS = 30 * 60 * 1000 // 30 min per task

export interface SprintRunOptions {
    sprintId: string
    workspaceId: string
    repo?: string         // required only for 'code' category
    category?: string     // defaults to 'code'
    request: string       // the user's request
    baseBranch?: string   // default: repo's default branch (code only)
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runSprint(opts: SprintRunOptions): Promise<void> {
    const { sprintId, workspaceId, category = 'code' } = opts

    logger.info({ sprintId, category }, 'Sprint run started')
    await db.update(sprints).set({ status: 'running' }).where(eq(sprints.id, sprintId))

    // Load the sprint row once to get project-level cost ceiling and per-task defaults
    const [sprintRow] = await db
        .select({ costCeilingUsd: sprints.costCeilingUsd, metadata: sprints.metadata })
        .from(sprints).where(eq(sprints.id, sprintId)).limit(1)

    const projectCostCeiling = sprintRow?.costCeilingUsd ?? null
    const metadata = (sprintRow?.metadata as Record<string, unknown>) ?? {}
    const perTaskCostCeiling = metadata.perTaskCostCeiling ? Number(metadata.perTaskCostCeiling) : null
    const perTaskTokenBudget = metadata.perTaskTokenBudget ? Number(metadata.perTaskTokenBudget) : null

    try {
        if (category === 'code') {
            await runCodeSprint(opts, sprintId, workspaceId, { projectCostCeiling, perTaskCostCeiling, perTaskTokenBudget })
        } else {
            await runGenericSprint(opts, sprintId, workspaceId, category, { projectCostCeiling, perTaskCostCeiling, perTaskTokenBudget })
        }
    } catch (err) {
        logger.error({ err, sprintId }, 'Sprint runner fatal error')
        await db.update(sprints).set({ status: 'failed' }).where(eq(sprints.id, sprintId))
        throw err
    }
}

interface SprintBudget {
    projectCostCeiling: number | null
    perTaskCostCeiling: number | null
    perTaskTokenBudget: number | null
}

async function checkProjectBudget(sprintId: string, ceiling: number | null): Promise<void> {
    if (ceiling == null) return
    const rows = await db
        .select({ total: sql<number>`COALESCE(SUM(cost_usd), 0)` })
        .from(tasks)
        .where(and(eq(tasks.projectId, sprintId), isNotNull(tasks.costUsd)))
    const spent = rows[0]?.total ?? 0
    if (spent >= ceiling) {
        throw new Error(`Project cost ceiling reached: $${spent.toFixed(4)} >= $${ceiling.toFixed(2)}`)
    }
}

// ── Code sprint (GitHub workflow) ─────────────────────────────────────────────

async function runCodeSprint(
    opts: SprintRunOptions,
    sprintId: string,
    workspaceId: string,
    budget: SprintBudget,
): Promise<void> {
    const repo = opts.repo
    if (!repo) throw new Error('repo is required for code category')

    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) throw new Error(`Invalid repo format: ${repo} — expected "owner/repo"`)

    const github = buildGitHubClient(owner, repoName)
    const baseBranch = opts.baseBranch ?? await github.getDefaultBranch()
    const baseSha = (await github.getBranch(baseBranch)).sha

    let contextFiles: string[] = []
    try {
        const files = await github.listFiles('', baseBranch)
        contextFiles = files.map((f) => f.path)
    } catch { /* non-fatal */ }

    const plan: PlanResult = await planSprint({
        sprintId,
        workspaceId,
        repo,
        request: opts.request,
        contextFiles,
        category: 'code',
    })

    const staticConflicts = detectStaticConflicts(
        plan.tasks.map((t) => ({ id: t.dbId, scope: t.scope })),
    )
    if (staticConflicts.length > 0) {
        logger.warn({ sprintId, staticConflicts }, 'Static scope conflicts detected')
    }

    for (const wave of plan.executionOrder) {
        const waveTasks = plan.tasks.filter((t) => wave.includes(t.id))
        logger.info({ sprintId, wave, taskCount: waveTasks.length }, 'Executing sprint wave')

        // Project budget gate: block wave if project ceiling already exhausted
        await checkProjectBudget(sprintId, budget.projectCostCeiling)

        await Promise.all(waveTasks.map(async (st) => {
            try { await github.createBranch(st.branch, baseSha) } catch (err) {
                logger.warn({ err, branch: st.branch }, 'Branch create failed — may already exist')
            }

            const taskId = await pushTask({
                workspaceId,
                type: 'coding',
                source: 'api',
                priority: st.priority,
                projectId: sprintId,
                // Propagate per-task budget ceilings from project settings
                costCeilingUsd: budget.perTaskCostCeiling ?? undefined,
                tokenBudget: budget.perTaskTokenBudget ?? undefined,
                context: {
                    description: st.description,
                    sprintId,
                    sprintTaskId: st.dbId,
                    branch: st.branch,
                    scope: st.scope,
                    acceptance: st.acceptance,
                    repo,
                    baseBranch,
                },
            })

            await db.update(sprintTasks)
                .set({ status: 'running', handoff: { taskId } })
                .where(eq(sprintTasks.id, st.dbId))
        }))

        await waitForWave(waveTasks.map((t) => t.dbId))

        const completed = await db.select().from(sprintTasks)
            .where(inArray(sprintTasks.id, waveTasks.map((t) => t.dbId)))

        for (const st of completed) {
            if (st.status === 'complete') {
                try {
                    const pr = await github.createPR({
                        title: `[Sprint ${sprintId.slice(0, 8)}] ${st.description}`,
                        body: `**Sprint:** ${sprintId}\n**Scope:** ${(st.scope as string[]).join(', ')}\n\n**Acceptance:** ${st.acceptance}`,
                        head: st.branch,
                        base: baseBranch,
                        draft: true,
                    })
                    await db.update(sprintTasks)
                        .set({ handoff: { ...(st.handoff as object ?? {}), prNumber: pr.number, prUrl: pr.html_url } })
                        .where(eq(sprintTasks.id, st.id))
                } catch (err) {
                    logger.warn({ err, branch: st.branch }, 'PR creation failed')
                }
            }
        }
    }

    const conflicts = await detectDynamicConflicts(sprintId, owner, repoName, baseBranch)
    const finalTasks = await db.select().from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))
    const completedCount = finalTasks.filter((t) => t.status === 'complete').length
    const failedCount = finalTasks.filter((t) => t.status === 'failed').length
    const sprintStatus: 'complete' | 'finalizing' | 'failed' = failedCount > 0
        ? (completedCount > 0 ? 'finalizing' : 'failed')
        : 'complete'

    // Aggregate actual project spend from completed tasks
    const [spendRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(cost_usd), 0)` })
        .from(tasks)
        .where(and(eq(tasks.projectId, sprintId), isNotNull(tasks.costUsd)))
    const totalCostUsd = spendRow?.total ?? 0

    await db.update(sprints).set({
        status: sprintStatus,
        completedTasks: completedCount,
        failedTasks: failedCount,
        conflictCount: conflicts.length,
        costUsd: totalCostUsd,
        completedAt: new Date(),
    }).where(eq(sprints.id, sprintId))

    logger.info({ sprintId, sprintStatus, completedCount, failedCount }, 'Code sprint complete')
}

// ── Generic sprint (no GitHub — research, writing, ops, data, marketing, general) ────

async function runGenericSprint(
    opts: SprintRunOptions,
    sprintId: string,
    workspaceId: string,
    category: string,
    budget: SprintBudget,
): Promise<void> {
    const plan: PlanResult = await planSprint({
        sprintId,
        workspaceId,
        repo: undefined,
        request: opts.request,
        contextFiles: [],
        category,
    })

    for (const wave of plan.executionOrder) {
        const waveTasks = plan.tasks.filter((t) => wave.includes(t.id))
        logger.info({ sprintId, wave, taskCount: waveTasks.length, category }, 'Executing generic wave')

        // Project budget gate
        await checkProjectBudget(sprintId, budget.projectCostCeiling)

        await Promise.all(waveTasks.map(async (st) => {
            const taskId = await pushTask({
                workspaceId,
                type: 'research',  // uses the research executor path for non-code
                source: 'api',
                priority: st.priority,
                projectId: sprintId,
                costCeilingUsd: budget.perTaskCostCeiling ?? undefined,
                tokenBudget: budget.perTaskTokenBudget ?? undefined,
                context: {
                    description: st.description,
                    sprintId,
                    sprintTaskId: st.dbId,
                    category,
                    scope: st.scope,
                    acceptance: st.acceptance,
                    branch: st.branch, // used as finding/asset/action ID
                },
            })

            await db.update(sprintTasks)
                .set({ status: 'running', handoff: { taskId } })
                .where(eq(sprintTasks.id, st.dbId))
        }))

        await waitForWave(waveTasks.map((t) => t.dbId))
    }

    const finalTasks = await db.select().from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))
    const completedCount = finalTasks.filter((t) => t.status === 'complete').length
    const failedCount = finalTasks.filter((t) => t.status === 'failed').length
    const sprintStatus: 'complete' | 'finalizing' | 'failed' = failedCount > 0
        ? (completedCount > 0 ? 'finalizing' : 'failed')
        : 'complete'

    // Aggregate actual project spend from completed tasks
    const [spendRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(cost_usd), 0)` })
        .from(tasks)
        .where(and(eq(tasks.projectId, sprintId), isNotNull(tasks.costUsd)))
    const totalCostUsd = spendRow?.total ?? 0

    await db.update(sprints).set({
        status: sprintStatus,
        completedTasks: completedCount,
        failedTasks: failedCount,
        costUsd: totalCostUsd,
        completedAt: new Date(),
    }).where(eq(sprints.id, sprintId))

    logger.info({ sprintId, sprintStatus, completedCount, failedCount, category }, 'Generic sprint complete')
}

// ── Poll helpers ──────────────────────────────────────────────────────────────

async function waitForWave(sprintTaskIds: string[]): Promise<void> {
    const deadline = Date.now() + TASK_TIMEOUT_MS

    while (Date.now() < deadline) {
        const rows = await db.select({ id: sprintTasks.id, status: sprintTasks.status })
            .from(sprintTasks)
            .where(inArray(sprintTasks.id, sprintTaskIds))

        const allDone = rows.every((r) => r.status === 'complete' || r.status === 'failed')
        if (allDone) return

        await new Promise((r) => setTimeout(r, TASK_POLL_MS))
    }

    // Timeout — mark remaining as failed
    const rows = await db.select({ id: sprintTasks.id, status: sprintTasks.status })
        .from(sprintTasks)
        .where(inArray(sprintTasks.id, sprintTaskIds))

    const timedOut = rows.filter((r) => r.status === 'running' || r.status === 'queued')
    if (timedOut.length > 0) {
        await db.update(sprintTasks)
            .set({ status: 'failed' })
            .where(inArray(sprintTasks.id, timedOut.map((r) => r.id)))

        logger.warn({ timedOut: timedOut.map((r) => r.id) }, 'Sprint wave tasks timed out')
    }
}
