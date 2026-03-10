// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import pino from 'pino'
import { db, eq, and, inArray, isNotNull, sql } from '@plexo/db'
import { sprints, sprintTasks, tasks, taskSteps } from '@plexo/db'
import { push as pushTask } from '@plexo/queue'
import { detectDynamicConflicts } from './conflicts.js'
import { buildGitHubClientForWorkspace } from '../github/client.js'
import { logSprintEvent, registerSprintWorkspace, unregisterSprintWorkspace } from './logger.js'
import { refreshSprintPatterns } from './sprint-ledger.js'
import { waitForWave } from './runner.js'

const logger = pino({ name: 'sprint-runner-retry' })

export async function runSprintRetry(sprintId: string, workspaceId: string): Promise<void> {
    const sprintStartMs = Date.now()

    logger.info({ sprintId }, 'Sprint retry started')
    registerSprintWorkspace(sprintId, workspaceId)

    try {
        const [sprintRow] = await db.select().from(sprints).where(eq(sprints.id, sprintId)).limit(1)
        if (!sprintRow) throw new Error('Sprint not found')

        const category = sprintRow.category ?? 'code'
        await db.update(sprints).set({ status: 'running' }).where(eq(sprints.id, sprintId))

        const waveTasks = await db.select().from(sprintTasks)
            .where(and(eq(sprintTasks.sprintId, sprintId), inArray(sprintTasks.status, ['failed', 'blocked'])))

        if (waveTasks.length === 0) {
            await db.update(sprints).set({ status: 'complete' }).where(eq(sprints.id, sprintId))
            return
        }

        await logSprintEvent({
            sprintId,
            event: 'wave_start',
            message: `Retry started — dispatching ${waveTasks.length} agent(s) in parallel`,
            metadata: { wave: 'retry', taskCount: waveTasks.length },
        })

        const metadata = (sprintRow.metadata as Record<string, unknown>) ?? {}
        const perTaskCostCeiling = metadata.perTaskCostCeiling ? Number(metadata.perTaskCostCeiling) : undefined
        const perTaskTokenBudget = metadata.perTaskTokenBudget ? Number(metadata.perTaskTokenBudget) : undefined

        let github: any = null
        let baseBranch: string | null = null
        let baseSha: string | null = null
        if (category === 'code' && sprintRow.repo) {
            const [owner, repoName] = sprintRow.repo.split('/')
            github = await buildGitHubClientForWorkspace(owner!, repoName!, workspaceId)
            baseBranch = await github.getDefaultBranch()
            baseSha = (await github.getBranch(baseBranch)).sha
        }

        await Promise.all(waveTasks.map(async (st) => {
            if (category === 'code' && github && baseSha) {
                try {
                    await github.createBranch(st.branch, baseSha)
                    await logSprintEvent({
                        sprintId,
                        event: 'branch_created',
                        message: `Branch reset/created: ${st.branch}`,
                        metadata: { branch: st.branch, taskId: st.id },
                    })
                } catch (err) {
                    // non-fatal
                }
            }

            const handoffObj = st.handoff as { outcome?: string } | null
            const previousError = handoffObj?.outcome
            const retryDescription = previousError
                ? `${st.description}\n\n[AUTOMATIC RETRY]\nPrevious attempt failed with error:\n\`\`\`\n${previousError}\n\`\`\`\nPlease analyze this failure and attempt a different approach to solve the issue.`
                : st.description

            const taskId = await pushTask({
                workspaceId,
                type: category === 'code' ? 'coding' : 'research',
                source: 'api',
                priority: st.priority,
                projectId: sprintId,
                costCeilingUsd: perTaskCostCeiling,
                tokenBudget: perTaskTokenBudget,
                context: {
                    description: retryDescription,
                    sprintId,
                    sprintTaskId: st.id,
                    ...(category === 'code' ? {
                        branch: st.branch,
                        scope: st.scope,
                        acceptance: st.acceptance,
                        repo: sprintRow.repo,
                        baseBranch,
                    } : {
                        category,
                        scope: st.scope,
                        acceptance: st.acceptance,
                        branch: st.branch,
                    }),
                    workspaceId,
                },
            })

            await db.update(sprintTasks)
                .set({ status: 'running', handoff: { taskId } })
                .where(eq(sprintTasks.id, st.id))

            await logSprintEvent({
                sprintId,
                event: 'task_running',
                message: `Agent retrying task: "${st.description.slice(0, 60)}…"`,
                metadata: { taskId, sprintTaskId: st.id },
            })
        }))

        await waitForWave(waveTasks.map(t => t.id), sprintId)

        const completed = await db.select().from(sprintTasks)
            .where(inArray(sprintTasks.id, waveTasks.map((t) => t.id)))

        for (const st of completed) {
            if (st.status === 'complete') {
                const linkedTaskId = (st.handoff as { taskId?: string } | null)?.taskId
                let resolvedModel: string | null = null
                if (linkedTaskId) {
                    try {
                        const [stepRow] = await db.select({ model: taskSteps.model })
                            .from(taskSteps).where(eq(taskSteps.taskId, linkedTaskId)).limit(1)
                        resolvedModel = stepRow?.model ?? null
                    } catch { /* ignore */ }
                }

                await logSprintEvent({
                    sprintId,
                    event: 'task_complete',
                    message: `Retry complete: "${st.description.slice(0, 80)}…"`,
                    metadata: { sprintTaskId: st.id, branch: st.branch, resolvedModel },
                })

                if (category === 'code' && github && baseBranch) {
                    try {
                        const hasWork = await github.hasCommitsAhead(baseBranch, st.branch)
                        if (hasWork) {
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
                        logger.warn({ err, branch: st.branch }, 'PR creation failed on retry')
                    }
                }
            } else if (st.status === 'failed') {
                await logSprintEvent({
                    sprintId,
                    level: 'warn',
                    event: 'task_failed',
                    message: `Retry failed: "${st.description.slice(0, 80)}…"`,
                    metadata: { sprintTaskId: st.id, branch: st.branch },
                })
            }
        }

        await logSprintEvent({
            sprintId,
            event: 'wave_complete',
            message: `Retry complete — ${completed.filter(t => t.status === 'complete').length} succeeded, ${completed.filter(t => t.status === 'failed').length} failed`,
            metadata: { wave: 'retry', succeeded: completed.filter(t => t.status === 'complete').length, failed: completed.filter(t => t.status === 'failed').length },
        })

        // Finalize Sprint
        let conflicts: any[] = []
        if (category === 'code' && sprintRow.repo && github && baseBranch) {
            const [owner, repoName] = sprintRow.repo.split('/')
            conflicts = await detectDynamicConflicts(sprintId, owner!, repoName!, baseBranch)
            if (conflicts.length > 0) {
                await logSprintEvent({
                    sprintId,
                    level: 'warn',
                    event: 'conflict_detected',
                    message: `${conflicts.length} dynamic merge conflict(s) detected across PRs`,
                    metadata: { conflictCount: conflicts.length },
                })
            }
        }

        const finalTasks = await db.select().from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))
        const completedCount = finalTasks.filter((t) => t.status === 'complete').length
        const failedCount = finalTasks.filter((t) => t.status === 'failed').length
        const sprintStatus: 'complete' | 'finalizing' | 'failed' = failedCount > 0
            ? (completedCount > 0 ? 'finalizing' : 'failed')
            : 'complete'

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
                : sprintStatus === 'finalizing' ? `Sprint finalizing — ${completedCount} succeeded, ${failedCount} failed, $${totalCostUsd.toFixed(4)} spent`
                : `Sprint failed — all ${failedCount} tasks failed`,
            metadata: { status: sprintStatus, completedCount, failedCount, totalCostUsd, conflictCount: conflicts.length },
        })
        
        if (category === 'code' && sprintRow.repo) {
            await refreshSprintPatterns(sprintRow.repo, sprintId)
        }
    } catch (err) {
        logger.error({ err, sprintId }, 'Sprint retry fatal error')
        await db.update(sprints).set({ status: 'failed' }).where(eq(sprints.id, sprintId))
        await logSprintEvent({
            sprintId,
            level: 'error',
            event: 'sprint_failed',
            message: `Retry failed: ${err instanceof Error ? err.message : String(err)}`,
            metadata: { error: String(err) },
        })
        throw err
    } finally {
        unregisterSprintWorkspace(sprintId)
    }
}
