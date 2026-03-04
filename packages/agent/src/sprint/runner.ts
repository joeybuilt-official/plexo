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
import { db, eq, inArray } from '@plexo/db'
import { sprints, sprintTasks } from '@plexo/db'
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
    repo: string          // e.g. "owner/repo"
    request: string       // the user's request
    baseBranch?: string   // default: repo's default branch
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runSprint(opts: SprintRunOptions): Promise<void> {
    const { sprintId, workspaceId, repo } = opts
    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) throw new Error(`Invalid repo format: ${repo} — expected "owner/repo"`)

    logger.info({ sprintId, repo }, 'Sprint run started')

    // Mark running
    await db.update(sprints).set({ status: 'running' }).where(eq(sprints.id, sprintId))

    try {
        const github = buildGitHubClient(owner, repoName)
        const baseBranch = opts.baseBranch ?? await github.getDefaultBranch()
        const baseSha = (await github.getBranch(baseBranch)).sha

        // Enumerate top-level files for planner context
        let contextFiles: string[] = []
        try {
            const files = await github.listFiles('', baseBranch)
            contextFiles = files.map((f) => f.path)
        } catch { /* non-fatal */ }

        // Plan
        const plan: PlanResult = await planSprint({
            sprintId,
            workspaceId,
            repo,
            request: opts.request,
            contextFiles,
        })

        // Static conflict warning (pre-execution)
        const staticConflicts = detectStaticConflicts(
            plan.tasks.map((t) => ({ id: t.dbId, scope: t.scope })),
        )
        if (staticConflicts.length > 0) {
            logger.warn({ sprintId, staticConflicts }, 'Static scope conflicts detected — tasks will run but may conflict')
        }

        // Execute waves
        for (const wave of plan.executionOrder) {
            const waveTasks = plan.tasks.filter((t) => wave.includes(t.id))

            logger.info({ sprintId, wave, taskCount: waveTasks.length }, 'Executing sprint wave')

            // Create branches and enqueue tasks in parallel
            await Promise.all(waveTasks.map(async (st) => {
                // Create branch from base
                try {
                    await github.createBranch(st.branch, baseSha)
                } catch (err) {
                    logger.warn({ err, branch: st.branch }, 'Branch create failed — may already exist')
                }

                // Enqueue as a regular coding task with sprint context
                const taskId = await pushTask({
                    workspaceId,
                    type: 'coding',
                    source: 'api',
                    priority: st.priority,
                    projectId: sprintId,          // FK → sprints.id
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

                // Link the queue task to sprint_task
                await db.update(sprintTasks)
                    .set({ status: 'running', handoff: { taskId } })
                    .where(eq(sprintTasks.id, st.dbId))
            }))

            // Wait for all tasks in wave to complete or fail
            await waitForWave(waveTasks.map((t) => t.dbId))

            // Create PRs for completed tasks
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
                            draft: true, // Draft until conflict check passes
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

        // Dynamic conflict detection
        const conflicts = await detectDynamicConflicts(sprintId, owner, repoName, baseBranch)

        // Tally results
        const finalTasks = await db.select().from(sprintTasks).where(eq(sprintTasks.sprintId, sprintId))
        const completedCount = finalTasks.filter((t) => t.status === 'complete').length
        const failedCount = finalTasks.filter((t) => t.status === 'failed').length

        const sprintStatus: 'complete' | 'finalizing' | 'failed' = failedCount > 0
            ? (completedCount > 0 ? 'finalizing' : 'failed')
            : 'complete'

        await db.update(sprints).set({
            status: sprintStatus,
            completedTasks: completedCount,
            failedTasks: failedCount,
            conflictCount: conflicts.length,
            completedAt: new Date(),
        }).where(eq(sprints.id, sprintId))

        logger.info({ sprintId, sprintStatus, completedCount, failedCount, conflictCount: conflicts.length }, 'Sprint complete')

    } catch (err) {
        logger.error({ err, sprintId }, 'Sprint runner fatal error')
        await db.update(sprints).set({ status: 'failed' }).where(eq(sprints.id, sprintId))
        throw err
    }
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
