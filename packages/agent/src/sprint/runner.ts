// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// SEC-036: RESOLVED — Each sprint task is already isolated. The agent-loop (agent-loop.ts)
// clones into a unique mkdtempSync() directory per task when it claims the job from the queue.
// Parallel tasks within the same wave never share a working directory.

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
import { push as pushTask, cancel as cancelTask } from '@plexo/queue'
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
    /** Analytics callback — called with anonymous sprint outcome metadata. */
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

    try {
        if (category === 'code' && process.env.ENABLE_SPRINT_CODING_TASKS !== 'true') {
            await db.update(sprints).set({ status: 'failed' }).where(eq(sprints.id, sprintId))
            await logSprintEvent({
                sprintId,
                level: 'error',
                event: 'sprint_failed',
                message: 'Sprint coding tasks are disabled on this instance (ENABLE_SPRINT_CODING_TASKS != true). Refused before any work.',
                metadata: { reason: 'SPRINT_CODING_DISABLED' },
            })
            throw new Error('Sprint coding tasks are disabled (ENABLE_SPRINT_CODING_TASKS != true)')
        }

        await db.update(sprints).set({ status: 'running' }).where(eq(sprints.id, sprintId))

        const [sprintRow] = await db
            .select({ costCeilingUsd: sprints.costCeilingUsd, metadata: sprints.metadata })
            .from(sprints).where(eq(sprints.id, sprintId)).limit(1)

        const projectCostCeiling = sprintRow?.costCeilingUsd ?? null
        const metadata = (sprintRow?.metadata as Record<string, unknown>) ?? {}
        const perTaskCostCeiling = metadata.perTaskCostCeiling ? Number(metadata.perTaskCostCeiling) : null
        const perTaskTokenBudget = metadata.perTaskTokenBudget ? Number(metadata.perTaskTokenBudget) : null

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

    // FUN-020: Persist baseSha in sprint metadata so retries branch from the
    // same commit instead of fetching fresh (avoids merge conflicts).
    try {
        const [row] = await db.select({ metadata: sprints.metadata }).from(sprints).where(eq(sprints.id, sprintId)).limit(1)
        const existingMeta = (row?.metadata as Record<string, unknown>) ?? {}
        await db.update(sprints).set({ metadata: { ...existingMeta, baseSha, baseBranch } }).where(eq(sprints.id, sprintId))
    } catch { /* non-fatal — retry will fall back to fresh fetch */ }

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

        // Executor-gap fix: use allSettled so a single failed push (e.g.,
        // queue cap reached, branch create error) doesn't abort the whole
        // wave mid-fan-out and leave half the sprint_tasks orphaned.
        const dispatchResults = await Promise.allSettled(waveTasks.map(async (st) => {
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

        // Surface dispatch failures so the wave doesn't silently strand sprint_tasks
        const dispatchFailures = dispatchResults
            .map((r, i) => r.status === 'rejected' ? { task: waveTasks[i]!, reason: r.reason } : null)
            .filter((x): x is { task: typeof waveTasks[number]; reason: unknown } => x !== null)
        if (dispatchFailures.length > 0) {
            // Mark the failed sprint_tasks as failed so the sprint accounting reflects reality
            await db.update(sprintTasks)
                .set({
                    status: 'failed',
                    handoff: sql`COALESCE(handoff, '{}'::jsonb) || ${JSON.stringify({ outcome: 'Dispatch failed before agent ran' })}::jsonb`,
                })
                .where(inArray(sprintTasks.id, dispatchFailures.map(f => f.task.dbId)))
            for (const f of dispatchFailures) {
                logger.warn({ sprintId, sprintTaskId: f.task.dbId, err: f.reason }, 'Sprint task dispatch failed — marked sprint_task as failed')
                await logSprintEvent({
                    sprintId,
                    level: 'error',
                    event: 'task_failed',
                    message: `Failed to dispatch task: ${f.task.description.slice(0, 80)}`,
                    metadata: { sprintTaskId: f.task.dbId, error: String(f.reason) },
                })
            }
        }

        await waitForWave(waveTasks.map((t) => t.dbId), sprintId)

        const completed = await db.select({
            id: sprintTasks.id,
            status: sprintTasks.status,
            description: sprintTasks.description,
            branch: sprintTasks.branch,
            scope: sprintTasks.scope,
            acceptance: sprintTasks.acceptance,
            handoff: sprintTasks.handoff,
        }).from(sprintTasks)
            .where(inArray(sprintTasks.id, waveTasks.map((t) => t.dbId)))

        // Batch-fetch model attribution for all completed tasks in one query
        const completedTaskIds = completed
            .filter(st => st.status === 'complete')
            .map(st => (st.handoff as { taskId?: string } | null)?.taskId)
            .filter((id): id is string => !!id)

        const modelMap = new Map<string, string>()
        if (completedTaskIds.length > 0) {
            try {
                const stepRows = await db.select({ taskId: taskSteps.taskId, model: taskSteps.model })
                    .from(taskSteps)
                    .where(inArray(taskSteps.taskId, completedTaskIds))
                for (const row of stepRows) {
                    if (row.taskId && row.model && !modelMap.has(row.taskId)) {
                        modelMap.set(row.taskId, row.model)
                    }
                }
            } catch { /* non-fatal */ }
        }

        for (const st of completed) {
            if (st.status === 'complete') {
                const linkedTaskId = (st.handoff as { taskId?: string } | null)?.taskId
                const resolvedModel = linkedTaskId ? modelMap.get(linkedTaskId) ?? null : null

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
            } else if (st.status === 'blocked') {
                await logSprintEvent({
                    sprintId,
                    level: 'warn',
                    event: 'task_blocked',
                    message: `Task blocked: "${st.description.slice(0, 80)}${st.description.length > 80 ? '…' : ''}"`,
                    metadata: { sprintTaskId: st.id, branch: st.branch },
                })
            }
        }

        await logSprintEvent({
            sprintId,
            event: 'wave_complete',
            message: `Wave ${waveIdx + 1} complete — ${completed.filter(t => t.status === 'complete').length} succeeded, ${completed.filter(t => t.status === 'failed').length} failed, ${completed.filter(t => t.status === 'blocked').length} blocked`,
            metadata: {
                wave: waveIdx + 1,
                succeeded: completed.filter(t => t.status === 'complete').length,
                failed: completed.filter(t => t.status === 'failed').length,
            },
        })
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

    const finalTasks = await db.select({ id: sprintTasks.id, status: sprintTasks.status }).from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))
    const completedCount = finalTasks.filter((t) => t.status === 'complete').length
    const failedCount = finalTasks.filter((t) => t.status === 'failed').length
    // Sprint-bug-fix: blocked tasks were silently dropped from accounting.
    // Treat them as terminal-non-success so the sprint reflects the truth.
    const blockedCount = finalTasks.filter((t) => t.status === 'blocked').length
    const unsuccessfulCount = failedCount + blockedCount
    const sprintStatus: 'complete' | 'finalizing' | 'failed' = unsuccessfulCount > 0
        ? (completedCount > 0 ? 'finalizing' : 'failed')
        : 'complete'

    // Aggregate actual project spend from completed tasks
    const [spendRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(cost_usd), 0)` })
        .from(tasks)
        .where(and(eq(tasks.projectId, sprintId), isNotNull(tasks.costUsd)))
    const totalCostUsd = spendRow?.total ?? 0

    // Sprint-bug-fix: only stamp completedAt when the sprint is actually
    // terminal. 'finalizing' means there are unfinished tasks awaiting
    // retry, so leaving completedAt null keeps reporting honest.
    const isTerminal = sprintStatus === 'complete' || sprintStatus === 'failed'
    await db.update(sprints).set({
        status: sprintStatus,
        completedTasks: completedCount,
        failedTasks: unsuccessfulCount,
        conflictCount: conflicts.length,
        costUsd: totalCostUsd,
        ...(isTerminal ? { completedAt: new Date() } : {}),
    }).where(eq(sprints.id, sprintId))

    await logSprintEvent({
        sprintId,
        level: sprintStatus === 'failed' ? 'error' : 'info',
        event: sprintStatus === 'failed' ? 'sprint_failed' : 'sprint_complete',
        message: sprintStatus === 'complete'
            ? `Sprint complete — ${completedCount}/${finalTasks.length} tasks succeeded, $${totalCostUsd.toFixed(4)} total cost`
            : sprintStatus === 'finalizing'
            ? `Sprint finalizing — ${completedCount} succeeded, ${failedCount} failed, ${blockedCount} blocked, $${totalCostUsd.toFixed(4)} spent`
            : `Sprint failed — all ${unsuccessfulCount} tasks unsuccessful (${failedCount} failed, ${blockedCount} blocked)`,
        metadata: { status: sprintStatus, completedCount, failedCount, blockedCount, totalCostUsd, conflictCount: conflicts.length },
    })

    logger.info({ sprintId, sprintStatus, completedCount, failedCount, blockedCount }, 'Code sprint complete')

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

        const completed = await db.select({
            id: sprintTasks.id,
            status: sprintTasks.status,
            description: sprintTasks.description,
        }).from(sprintTasks)
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
        const allSoFar = await db.select({ status: sprintTasks.status }).from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))
        const [waveCostRow] = await db.select({ total: sql<number>`COALESCE(SUM(cost_usd), 0)` })
            .from(tasks).where(and(eq(tasks.projectId, sprintId), isNotNull(tasks.costUsd)))
        await db.update(sprints).set({
            completedTasks: allSoFar.filter((t) => t.status === 'complete').length,
            failedTasks: allSoFar.filter((t) => t.status === 'failed').length,
            costUsd: waveCostRow?.total ?? 0,
        }).where(eq(sprints.id, sprintId))
    }

    const finalTasks = await db.select({ id: sprintTasks.id, status: sprintTasks.status }).from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))
    const completedCount = finalTasks.filter((t) => t.status === 'complete').length
    const failedCount = finalTasks.filter((t) => t.status === 'failed').length
    const blockedCount = finalTasks.filter((t) => t.status === 'blocked').length
    const unsuccessfulCount = failedCount + blockedCount
    const sprintStatus: 'complete' | 'finalizing' | 'failed' = unsuccessfulCount > 0
        ? (completedCount > 0 ? 'finalizing' : 'failed')
        : 'complete'

    // Aggregate actual project spend from completed tasks
    const [spendRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(cost_usd), 0)` })
        .from(tasks)
        .where(and(eq(tasks.projectId, sprintId), isNotNull(tasks.costUsd)))
    const totalCostUsd = spendRow?.total ?? 0

    const isTerminal = sprintStatus === 'complete' || sprintStatus === 'failed'
    await db.update(sprints).set({
        status: sprintStatus,
        completedTasks: completedCount,
        failedTasks: unsuccessfulCount,
        costUsd: totalCostUsd,
        ...(isTerminal ? { completedAt: new Date() } : {}),
    }).where(eq(sprints.id, sprintId))

    await logSprintEvent({
        sprintId,
        level: sprintStatus === 'failed' ? 'error' : 'info',
        event: sprintStatus === 'failed' ? 'sprint_failed' : 'sprint_complete',
        message: sprintStatus === 'complete'
            ? `Sprint complete — ${completedCount}/${finalTasks.length} tasks done, $${totalCostUsd.toFixed(4)} total cost`
            : `Sprint done with errors — ${completedCount} succeeded, ${failedCount} failed, ${blockedCount} blocked`,
        metadata: { status: sprintStatus, completedCount, failedCount, blockedCount, totalCostUsd },
    })

    logger.info({ sprintId, sprintStatus, completedCount, failedCount, blockedCount, category }, 'Generic sprint complete')

    opts.onComplete?.({
        taskCount: finalTasks.length,
        waveCount: plan.executionOrder.length,
        success: sprintStatus !== 'failed',
        durationMs: Date.now() - sprintStartMs,
        category,
    })
}

// ── Poll helpers ──────────────────────────────────────────────────────────────

export async function waitForWave(sprintTaskIds: string[], sprintId: string): Promise<void> {
    const deadline = Date.now() + TASK_TIMEOUT_MS

    while (Date.now() < deadline) {
        const [sprintRow] = await db.select({ status: sprints.status })
            .from(sprints).where(eq(sprints.id, sprintId)).limit(1)
        if (sprintRow?.status === 'cancelled') {
            // Cancel all running/queued tasks in this wave so they stop
            // burning tokens. Fetch the underlying queue task IDs from
            // the sprint_tasks handoff column, then cancel via @plexo/queue.
            const runningRows = await db.select({
                id: sprintTasks.id,
                status: sprintTasks.status,
                handoff: sprintTasks.handoff,
            }).from(sprintTasks)
                .where(inArray(sprintTasks.id, sprintTaskIds))

            const toCancel = runningRows.filter((r) => r.status === 'running' || r.status === 'queued')
            if (toCancel.length > 0) {
                await Promise.allSettled(toCancel.map(async (r) => {
                    // Cancel the underlying queue task
                    const queueTaskId = (r.handoff as { taskId?: string } | null)?.taskId
                    if (queueTaskId) {
                        await cancelTask(queueTaskId)
                    }
                    // Mark the sprint task as failed (enum has no 'cancelled' value)
                    await db.update(sprintTasks)
                        .set({ status: 'failed' })
                        .where(eq(sprintTasks.id, r.id))
                }))

                await logSprintEvent({
                    sprintId,
                    event: 'sprint_cancelled',
                    message: `Sprint cancelled — ${toCancel.length} running task(s) cancelled`,
                    metadata: { cancelledIds: toCancel.map((r) => r.id) },
                })

                logger.info({ sprintId, cancelledCount: toCancel.length }, 'Sprint cancelled — running tasks terminated')
            }

            throw new Error('Sprint cancelled by user')
        }

        const rows = await db.select({ id: sprintTasks.id, status: sprintTasks.status })
            .from(sprintTasks)
            .where(inArray(sprintTasks.id, sprintTaskIds))

        const allDone = rows.every((r) => r.status === 'complete' || r.status === 'failed' || r.status === 'blocked')
        if (allDone) return

        await new Promise((r) => setTimeout(r, TASK_POLL_MS))
    }

    // Timeout — cancel underlying queue tasks, then mark sprint_tasks as failed
    const rows = await db.select({ id: sprintTasks.id, status: sprintTasks.status, handoff: sprintTasks.handoff })
        .from(sprintTasks)
        .where(inArray(sprintTasks.id, sprintTaskIds))

    const timedOut = rows.filter((r) => r.status === 'running' || r.status === 'queued')
    if (timedOut.length > 0) {
        // Cancel the underlying queue tasks so they don't keep running
        await Promise.allSettled(timedOut.map(async (r) => {
            const queueTaskId = (r.handoff as { taskId?: string } | null)?.taskId
            if (queueTaskId) {
                await cancelTask(queueTaskId)
            }
        }))

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
