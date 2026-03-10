// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

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
import { sprints, sprintTasks, tasks, taskSteps } from '@plexo/db'
import { push as pushTask } from '@plexo/queue'
import { planSprint, type PlanResult } from './planner.js'
import { detectStaticConflicts, detectDynamicConflicts } from './conflicts.js'
import { SprintIntelligence } from './sprint-intelligence.js'
import { buildGitHubClientForWorkspace } from '../github/client.js'
import {
    logSprintEvent,
    registerSprintWorkspace,
    unregisterSprintWorkspace,
} from './logger.js'
import { refreshSprintPatterns } from './sprint-ledger.js'

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    aiSettings?: any      // workspace AI settings object for fallback routing
    /** Telemetry callback — called with anonymous sprint outcome metadata. */
    onComplete?: (meta: {
        taskCount: number
        waveCount: number
        success: boolean
        durationMs: number
        category: string
    }) => void
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runSprint(opts: SprintRunOptions): Promise<void> {
    const { sprintId, workspaceId, category = 'code' } = opts
    const sprintStartMs = Date.now()

    logger.info({ sprintId, category }, 'Sprint run started')
    registerSprintWorkspace(sprintId, workspaceId)

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
            await runCodeSprint(opts, sprintId, workspaceId, { projectCostCeiling, perTaskCostCeiling, perTaskTokenBudget }, sprintStartMs)
        } else {
            await runGenericSprint(opts, sprintId, workspaceId, category, { projectCostCeiling, perTaskCostCeiling, perTaskTokenBudget }, sprintStartMs)
        }
    } catch (err) {
        logger.error({ err, sprintId }, 'Sprint runner fatal error')
        await db.update(sprints).set({ status: 'failed' }).where(eq(sprints.id, sprintId))
        await logSprintEvent({
            sprintId,
            level: 'error',
            event: 'sprint_failed',
            message: `Sprint failed: ${err instanceof Error ? err.message : String(err)}`,
            metadata: { error: String(err) },
        })
        throw err
    } finally {
        unregisterSprintWorkspace(sprintId)
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

    await logSprintEvent({
        sprintId,
        event: 'budget_check',
        message: `Budget check: $${spent.toFixed(4)} spent of $${ceiling.toFixed(2)} ceiling`,
        metadata: { spent, ceiling },
    })

    if (spent >= ceiling) {
        await logSprintEvent({
            sprintId,
            level: 'warn',
            event: 'budget_ceiling_hit',
            message: `Project cost ceiling reached ($${spent.toFixed(4)} ≥ $${ceiling.toFixed(2)}) — halting`,
            metadata: { spent, ceiling },
        })
        throw new Error(`Project cost ceiling reached: $${spent.toFixed(4)} >= $${ceiling.toFixed(2)}`)
    }
}

// ── Code sprint (GitHub workflow) ─────────────────────────────────────────────

async function runCodeSprint(
    opts: SprintRunOptions,
    sprintId: string,
    workspaceId: string,
    budget: SprintBudget,
    sprintStartMs: number,
): Promise<void> {
    const repo = opts.repo
    if (!repo) throw new Error('repo is required for code category')

    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) throw new Error(`Invalid repo format: ${repo} — expected "owner/repo"`)

    await logSprintEvent({
        sprintId,
        event: 'planning_start',
        message: `Planning started for ${repo} — analyzing repository and decomposing work`,
        metadata: { repo, category: 'code' },
    })

    const github = await buildGitHubClientForWorkspace(owner, repoName, workspaceId)
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
        aiSettings: opts.aiSettings,
    })

    await logSprintEvent({
        sprintId,
        event: 'planning_complete',
        message: `Planning complete — ${plan.tasks.length} tasks across ${plan.executionOrder.length} wave(s)`,
        metadata: {
            taskCount: plan.tasks.length,
            waveCount: plan.executionOrder.length,
            tasks: plan.tasks.map((t) => ({ id: t.id, description: t.description, branch: t.branch })),
        },
    })

    const intel = new SprintIntelligence(repo)
    const filesInScope = Array.from(new Set(plan.tasks.flatMap(t => t.scope)))
    const forecastScore = await intel.forecastQuality(sprintId, opts.request, filesInScope)

    await logSprintEvent({
        sprintId,
        event: 'quality_forecast',
        message: `Quality forecast score: ${forecastScore.toFixed(2)}`,
        metadata: { forecastScore },
    })

    const staticConflicts = detectStaticConflicts(
        plan.tasks.map((t) => ({ id: t.dbId, scope: t.scope })),
    )
    if (staticConflicts.length > 0) {
        logger.warn({ sprintId, staticConflicts }, 'Static scope conflicts detected')
        await logSprintEvent({
            sprintId,
            level: 'warn',
            event: 'conflict_detected',
            message: `${staticConflicts.length} static scope conflict(s) detected — some tasks may overlap`,
            metadata: { conflicts: staticConflicts },
        })
    }

    for (let waveIdx = 0; waveIdx < plan.executionOrder.length; waveIdx++) {
        const wave = plan.executionOrder[waveIdx]!
        const waveTasks = plan.tasks.filter((t) => wave.includes(t.id))

        await logSprintEvent({
            sprintId,
            event: 'wave_start',
            message: `Wave ${waveIdx + 1}/${plan.executionOrder.length} — dispatching ${waveTasks.length} agent(s) in parallel`,
            metadata: { wave: waveIdx + 1, totalWaves: plan.executionOrder.length, taskCount: waveTasks.length },
        })

        logger.info({ sprintId, wave, taskCount: waveTasks.length }, 'Executing sprint wave')

        // Project budget gate: block wave if project ceiling already exhausted
        await checkProjectBudget(sprintId, budget.projectCostCeiling)

        await Promise.all(waveTasks.map(async (st) => {
            try {
                await github.createBranch(st.branch, baseSha)
                await logSprintEvent({
                    sprintId,
                    event: 'branch_created',
                    message: `Branch created: ${st.branch}`,
                    metadata: { branch: st.branch, taskId: st.dbId },
                })
            } catch (err) {
                logger.warn({ err, branch: st.branch }, 'Branch create failed — may already exist')
                await logSprintEvent({
                    sprintId,
                    level: 'warn',
                    event: 'branch_failed',
                    message: `Branch ${st.branch} already exists or creation failed — continuing`,
                    metadata: { branch: st.branch, error: String(err) },
                })
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
                    // workspaceId propagated so executor can resolve GitHub token
                    workspaceId,
                },
            })

            await logSprintEvent({
                sprintId,
                event: 'task_queued',
                message: `Agent queued: "${st.description.slice(0, 80)}${st.description.length > 80 ? '…' : ''}"`,
                metadata: { taskId, sprintTaskId: st.dbId, branch: st.branch, description: st.description },
            })

            await db.update(sprintTasks)
                .set({ status: 'running', handoff: { taskId } })
                .where(eq(sprintTasks.id, st.dbId))

            await logSprintEvent({
                sprintId,
                event: 'task_running',
                message: `Agent running on branch ${st.branch}`,
                metadata: { taskId, sprintTaskId: st.dbId, branch: st.branch },
            })
        }))

        await waitForWave(waveTasks.map((t) => t.dbId), sprintId)

        const completed = await db.select().from(sprintTasks)
            .where(inArray(sprintTasks.id, waveTasks.map((t) => t.dbId)))

        for (const st of completed) {
            if (st.status === 'complete') {
                // Query model attribution from task_steps if available
                const linkedTaskId = (st.handoff as { taskId?: string } | null)?.taskId
                let resolvedModel: string | null = null
                if (linkedTaskId) {
                    try {
                        const [stepRow] = await db.select({ model: taskSteps.model })
                            .from(taskSteps)
                            .where(eq(taskSteps.taskId, linkedTaskId))
                            .limit(1)
                        resolvedModel = stepRow?.model ?? null
                    } catch { /* non-fatal */ }
                }

                await logSprintEvent({
                    sprintId,
                    event: 'task_complete',
                    message: `Task complete: "${st.description.slice(0, 80)}${st.description.length > 80 ? '…' : ''}"`,
                    metadata: { sprintTaskId: st.id, branch: st.branch, resolvedModel },
                })

                try {
                    // Only open a PR if the executor actually pushed commits.
                    // createPR will 422 if the branch is identical to base.
                    const hasWork = await github.hasCommitsAhead(baseBranch, st.branch)
                    if (!hasWork) {
                        await logSprintEvent({
                            sprintId,
                            level: 'warn',
                            event: 'pr_skipped',
                            message: `No commits pushed to ${st.branch} — PR skipped`,
                            metadata: { branch: st.branch, sprintTaskId: st.id },
                        })
                    } else {
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

                        await logSprintEvent({
                            sprintId,
                            event: 'pr_created',
                            message: `PR #${pr.number} created for ${st.branch}`,
                            metadata: { prNumber: pr.number, prUrl: pr.html_url, branch: st.branch, sprintTaskId: st.id },
                        })
                    }
                } catch (err) {
                    logger.warn({ err, branch: st.branch }, 'PR creation failed')
                    await logSprintEvent({
                        sprintId,
                        level: 'warn',
                        event: 'pr_failed',
                        message: `PR creation failed for ${st.branch}: ${err instanceof Error ? err.message : String(err)}`,
                        metadata: { branch: st.branch, error: String(err) },
                    })
                }
            } else if (st.status === 'failed') {
                await logSprintEvent({
                    sprintId,
                    level: 'warn',
                    event: 'task_failed',
                    message: `Task failed: "${st.description.slice(0, 80)}${st.description.length > 80 ? '…' : ''}"`,
                    metadata: { sprintTaskId: st.id, branch: st.branch },
                })
            }
        }

        await logSprintEvent({
            sprintId,
            event: 'wave_complete',
            message: `Wave ${waveIdx + 1} complete — ${completed.filter(t => t.status === 'complete').length} succeeded, ${completed.filter(t => t.status === 'failed').length} failed`,
            metadata: {
                wave: waveIdx + 1,
                succeeded: completed.filter(t => t.status === 'complete').length,
                failed: completed.filter(t => t.status === 'failed').length,
            },
        })
        // Incremental progress + cost — update sprints row after each wave so UI updates in real-time
        const allSoFar = await db.select({ status: sprintTasks.status }).from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))
        const [waveCostRow] = await db.select({ total: sql<number>`COALESCE(SUM(cost_usd), 0)` })
            .from(tasks).where(and(eq(tasks.projectId, sprintId), isNotNull(tasks.costUsd)))
        await db.update(sprints).set({
            completedTasks: allSoFar.filter((t) => t.status === 'complete').length,
            failedTasks: allSoFar.filter((t) => t.status === 'failed').length,
            costUsd: waveCostRow?.total ?? 0,
        }).where(eq(sprints.id, sprintId))
    }

    const conflicts = await detectDynamicConflicts(sprintId, owner, repoName, baseBranch)
    if (conflicts.length > 0) {
        await logSprintEvent({
            sprintId,
            level: 'warn',
            event: 'conflict_detected',
            message: `${conflicts.length} dynamic merge conflict(s) detected across PRs`,
            metadata: { conflictCount: conflicts.length },
        })
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
        conflictCount: conflicts.length,
        costUsd: totalCostUsd,
        completedAt: new Date(),
    }).where(eq(sprints.id, sprintId))

    await logSprintEvent({
        sprintId,
        level: sprintStatus === 'failed' ? 'error' : 'info',
        event: sprintStatus === 'failed' ? 'sprint_failed' : 'sprint_complete',
        message: sprintStatus === 'complete'
            ? `Sprint complete — ${completedCount}/${finalTasks.length} tasks succeeded, $${totalCostUsd.toFixed(4)} total cost`
            : sprintStatus === 'finalizing'
            ? `Sprint finalizing — ${completedCount} succeeded, ${failedCount} failed, $${totalCostUsd.toFixed(4)} spent`
            : `Sprint failed — all ${failedCount} tasks failed`,
        metadata: { status: sprintStatus, completedCount, failedCount, totalCostUsd, conflictCount: conflicts.length },
    })

    logger.info({ sprintId, sprintStatus, completedCount, failedCount }, 'Code sprint complete')

    await refreshSprintPatterns(repo, sprintId)

    opts.onComplete?.({
        taskCount: finalTasks.length,
        waveCount: plan.executionOrder.length,
        success: sprintStatus !== 'failed',
        durationMs: Date.now() - sprintStartMs,
        category: 'code',
    })
}

// ── Generic sprint (no GitHub — research, writing, ops, data, marketing, general) ────

async function runGenericSprint(
    opts: SprintRunOptions,
    sprintId: string,
    workspaceId: string,
    category: string,
    budget: SprintBudget,
    sprintStartMs: number,
): Promise<void> {
    await logSprintEvent({
        sprintId,
        event: 'planning_start',
        message: `Planning started — analyzing request and decomposing work (${category})`,
        metadata: { category },
    })

    const plan: PlanResult = await planSprint({
        sprintId,
        workspaceId,
        repo: undefined,
        request: opts.request,
        contextFiles: [],
        category,
        aiSettings: opts.aiSettings,
    })

    await logSprintEvent({
        sprintId,
        event: 'planning_complete',
        message: `Planning complete — ${plan.tasks.length} tasks across ${plan.executionOrder.length} wave(s)`,
        metadata: {
            taskCount: plan.tasks.length,
            waveCount: plan.executionOrder.length,
            category,
        },
    })

    for (let waveIdx = 0; waveIdx < plan.executionOrder.length; waveIdx++) {
        const wave = plan.executionOrder[waveIdx]!
        const waveTasks = plan.tasks.filter((t) => wave.includes(t.id))

        await logSprintEvent({
            sprintId,
            event: 'wave_start',
            message: `Wave ${waveIdx + 1}/${plan.executionOrder.length} — dispatching ${waveTasks.length} agent(s)`,
            metadata: { wave: waveIdx + 1, totalWaves: plan.executionOrder.length, taskCount: waveTasks.length },
        })

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

            await logSprintEvent({
                sprintId,
                event: 'task_queued',
                message: `Agent queued: "${st.description.slice(0, 80)}${st.description.length > 80 ? '…' : ''}"`,
                metadata: { taskId, sprintTaskId: st.dbId, description: st.description },
            })

            await db.update(sprintTasks)
                .set({ status: 'running', handoff: { taskId } })
                .where(eq(sprintTasks.id, st.dbId))

            await logSprintEvent({
                sprintId,
                event: 'task_running',
                message: `Agent working on: "${st.description.slice(0, 60)}…"`,
                metadata: { taskId, sprintTaskId: st.dbId },
            })
        }))

        await waitForWave(waveTasks.map((t) => t.dbId), sprintId)

        const completed = await db.select().from(sprintTasks)
            .where(inArray(sprintTasks.id, waveTasks.map((t) => t.dbId)))

        for (const st of completed) {
            if (st.status === 'complete') {
                await logSprintEvent({
                    sprintId,
                    event: 'task_complete',
                    message: `Task complete: "${st.description.slice(0, 80)}${st.description.length > 80 ? '…' : ''}"`,
                    metadata: { sprintTaskId: st.id },
                })
            } else if (st.status === 'failed') {
                await logSprintEvent({
                    sprintId,
                    level: 'warn',
                    event: 'task_failed',
                    message: `Task failed: "${st.description.slice(0, 80)}${st.description.length > 80 ? '…' : ''}"`,
                    metadata: { sprintTaskId: st.id },
                })
            }
        }

        await logSprintEvent({
            sprintId,
            event: 'wave_complete',
            message: `Wave ${waveIdx + 1} complete`,
            metadata: {
                wave: waveIdx + 1,
                succeeded: completed.filter(t => t.status === 'complete').length,
                failed: completed.filter(t => t.status === 'failed').length,
            },
        })
        // Incremental progress + cost — update sprints row after each wave so UI updates in real-time
        const allSoFar = await db.select({ status: sprintTasks.status }).from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))
        const [waveCostRow] = await db.select({ total: sql<number>`COALESCE(SUM(cost_usd), 0)` })
            .from(tasks).where(and(eq(tasks.projectId, sprintId), isNotNull(tasks.costUsd)))
        await db.update(sprints).set({
            completedTasks: allSoFar.filter((t) => t.status === 'complete').length,
            failedTasks: allSoFar.filter((t) => t.status === 'failed').length,
            costUsd: waveCostRow?.total ?? 0,
        }).where(eq(sprints.id, sprintId))
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

    await logSprintEvent({
        sprintId,
        level: sprintStatus === 'failed' ? 'error' : 'info',
        event: sprintStatus === 'failed' ? 'sprint_failed' : 'sprint_complete',
        message: sprintStatus === 'complete'
            ? `Sprint complete — ${completedCount}/${finalTasks.length} tasks done, $${totalCostUsd.toFixed(4)} total cost`
            : `Sprint done with errors — ${completedCount} succeeded, ${failedCount} failed`,
        metadata: { status: sprintStatus, completedCount, failedCount, totalCostUsd },
    })

    logger.info({ sprintId, sprintStatus, completedCount, failedCount, category }, 'Generic sprint complete')

    opts.onComplete?.({
        taskCount: finalTasks.length,
        waveCount: plan.executionOrder.length,
        success: sprintStatus !== 'failed',
        durationMs: Date.now() - sprintStartMs,
        category,
    })
}

// ── Poll helpers ──────────────────────────────────────────────────────────────

async function waitForWave(sprintTaskIds: string[], sprintId: string): Promise<void> {
    const deadline = Date.now() + TASK_TIMEOUT_MS

    while (Date.now() < deadline) {
        // Check if the sprint itself was cancelled
        const [sprintRow] = await db.select({ status: sprints.status })
            .from(sprints).where(eq(sprints.id, sprintId)).limit(1)
        if (sprintRow?.status === 'cancelled') {
            throw new Error('Sprint cancelled by user')
        }

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

        await logSprintEvent({
            sprintId,
            level: 'warn',
            event: 'task_timeout',
            message: `${timedOut.length} task(s) timed out after ${TASK_TIMEOUT_MS / 60_000}m and were marked failed`,
            metadata: { timedOutIds: timedOut.map((r) => r.id) },
        })

        logger.warn({ timedOut: timedOut.map((r) => r.id) }, 'Sprint wave tasks timed out')
    }
}
