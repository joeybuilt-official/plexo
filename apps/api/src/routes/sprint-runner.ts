/**
 * Sprint engine API — start, status, task tree.
 *
 * POST   /api/sprints/:id/run        Start sprint execution
 * DELETE /api/sprints/:id            Cancel a running (or any) sprint
 * GET    /api/sprints/:id/tasks      Sprint task tree with status
 * GET    /api/sprints/:id/conflicts  Conflict report for a sprint
 * GET    /api/sprints/:id/logs       Activity log
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, asc, inArray } from '@plexo/db'
import { sprints, sprintTasks, sprintLogs, tasks } from '@plexo/db'
import { runSprint } from '@plexo/agent/sprint/runner'
import { detectDynamicConflicts } from '@plexo/agent/sprint/conflicts'
import { resolveModel } from '@plexo/agent/providers/registry'
import { loadWorkspaceAISettings, cancelActiveTask } from '../agent-loop.js'
import { logSprintEvent } from '@plexo/agent/sprint/logger'
import { logger } from '../logger.js'
import { emitToWorkspace } from '../sse-emitter.js'

export const sprintRunnerRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── POST /api/sprints/:id/run ─────────────────────────────────────────────────

sprintRunnerRouter.post('/:id/run', async (req, res) => {
    const { id: sprintId } = req.params
    const { workspaceId } = req.body as { workspaceId?: string }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    // Validate sprint exists
    const [sprint] = await db.select().from(sprints).where(eq(sprints.id, sprintId)).limit(1)
    if (!sprint) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
        return
    }

    if (sprint.status === 'running') {
        res.status(409).json({ error: { code: 'ALREADY_RUNNING', message: 'Sprint is already running' } })
        return
    }

    // Load workspace AI settings so the planner uses the configured provider
    let plannerModel: ReturnType<typeof resolveModel> | undefined
    try {
        const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (aiSettings) {
            plannerModel = resolveModel('planning', aiSettings)
            logger.info({ sprintId, provider: aiSettings.primaryProvider }, 'Sprint planner model resolved')
        }
    } catch (err) {
        logger.warn({ err, sprintId }, 'Could not resolve workspace AI settings — planner will use env fallback')
    }

    // Fire-and-forget — sprint runs async, SSE keeps client updated
    runSprint({
        sprintId,
        workspaceId,
        repo: sprint.repo ?? undefined,
        category: sprint.category ?? 'code',
        request: sprint.request,
        plannerModel,
    }).catch((err: unknown) => {
        logger.error({ err, sprintId }, 'Sprint run failed')
    })

    res.status(202).json({ sprintId, status: 'started', message: 'Sprint execution started — follow progress via SSE' })
})

// ── DELETE /api/sprints/:id ───────────────────────────────────────────────────
// Cancels a sprint (any status) and cascades to all its tasks.
// - Sets sprints.status = 'cancelled' → waitForWave in runner.ts detects this
//   and throws, causing the async runner to stop cleanly at the next wave poll.
// - Cancels all tasks (tasks table) belonging to the sprint.
// - Aborts the active AbortController if the currently-running task belongs to
//   this sprint (via cancelActiveTask exported from agent-loop.ts).
// - Marks all sprint_tasks rows that are still queued/running as 'failed'.

sprintRunnerRouter.delete('/:id', async (req, res) => {
    const { id: sprintId } = req.params

    try {
        const [sprint] = await db
            .select({ id: sprints.id, status: sprints.status, workspaceId: sprints.workspaceId })
            .from(sprints)
            .where(eq(sprints.id, sprintId))
            .limit(1)

        if (!sprint) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
            return
        }

        // 1. Tombstone the sprint — waitForWave in runner.ts polls sprints.status
        //    and will throw 'Sprint cancelled by user' on its next iteration.
        await db.update(sprints)
            .set({ status: 'cancelled', completedAt: new Date() })
            .where(eq(sprints.id, sprintId))

        // 2. Fetch all tasks that belong to this sprint, cancel them
        const allTaskIds = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(eq(tasks.projectId, sprintId))
            .then((rows) => rows.map((r) => r.id))

        let abortedCount = 0
        if (allTaskIds.length > 0) {
            await db.update(tasks)
                .set({ status: 'cancelled' })
                .where(inArray(tasks.id, allTaskIds))

            // Immediately signal the executor if one of these tasks is actively running
            for (const taskId of allTaskIds) {
                if (cancelActiveTask(taskId)) {
                    abortedCount++
                    break // single-worker loop: at most one executes at a time
                }
            }
        }

        // 3. Mark in-flight sprint_tasks rows as failed
        const stRows = await db
            .select({ id: sprintTasks.id, status: sprintTasks.status })
            .from(sprintTasks)
            .where(eq(sprintTasks.sprintId, sprintId))

        const stInFlight = stRows
            .filter((t) => t.status === 'queued' || t.status === 'running')
            .map((t) => t.id)

        if (stInFlight.length > 0) {
            await db.update(sprintTasks)
                .set({ status: 'failed' })
                .where(inArray(sprintTasks.id, stInFlight))
        }

        // 4. Log + emit
        await logSprintEvent({
            sprintId,
            level: 'warn',
            event: 'sprint_cancelled',
            message: `Sprint cancelled — ${allTaskIds.length} task(s) terminated, ${abortedCount} executor(s) interrupted`,
            metadata: { cancelledTaskCount: allTaskIds.length, abortedCount },
        })

        logger.info({ sprintId, cancelledTasks: allTaskIds.length, abortedCount }, 'Sprint cancelled')
        emitToWorkspace(sprint.workspaceId ?? '', { type: 'sprint_cancelled', sprintId })

        res.json({ ok: true, cancelledTasks: allTaskIds.length, abortedCount })
    } catch (err) {
        logger.error({ err, sprintId }, 'DELETE /api/sprints/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to cancel sprint' } })
    }
})

// ── GET /api/sprints/:id/tasks ────────────────────────────────────────────────

sprintRunnerRouter.get('/:id/tasks', async (req, res) => {
    const { id: sprintId } = req.params

    try {
        const [sprint] = await db.select().from(sprints).where(eq(sprints.id, sprintId)).limit(1)
        if (!sprint) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
            return
        }

        const taskRows = await db.select().from(sprintTasks)
            .where(eq(sprintTasks.sprintId, sprintId))
            .orderBy(sprintTasks.priority)

        res.json({
            sprint: {
                id: sprint.id,
                repo: sprint.repo,
                category: sprint.category ?? 'code',
                request: sprint.request,
                status: sprint.status,
                totalTasks: sprint.totalTasks,
                completedTasks: sprint.completedTasks,
                failedTasks: sprint.failedTasks,
                conflictCount: sprint.conflictCount,
                qualityScore: sprint.qualityScore,
                costUsd: sprint.costUsd,
                wallClockMs: sprint.wallClockMs,
                plannerIterations: sprint.plannerIterations,
                featuresCompleted: sprint.featuresCompleted ?? [],
                createdAt: sprint.createdAt,
                completedAt: sprint.completedAt,
            },
            tasks: taskRows.map((t) => ({
                id: t.id,
                description: t.description,
                scope: t.scope,
                acceptance: t.acceptance,
                branch: t.branch,
                priority: t.priority,
                status: t.status,
                handoff: t.handoff,
                createdAt: t.createdAt,
                completedAt: t.completedAt,
            })),
        })
    } catch (err) {
        logger.error({ err, sprintId }, 'GET /api/sprints/:id/tasks failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch sprint tasks' } })
    }
})

// ── GET /api/sprints/:id/conflicts ────────────────────────────────────────────

sprintRunnerRouter.get('/:id/conflicts', async (req, res) => {
    const { id: sprintId } = req.params

    try {
        const [sprint] = await db.select({ repo: sprints.repo }).from(sprints)
            .where(eq(sprints.id, sprintId)).limit(1)

        if (!sprint) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
            return
        }

        const [owner, repo] = (sprint.repo ?? '').split('/')
        if (!owner || !repo || !process.env.GITHUB_TOKEN) {
            res.json({ conflicts: [], note: 'GitHub integration not configured or not a code project' })
            return
        }

        const conflicts = await detectDynamicConflicts(sprintId, owner, repo, 'main')
        res.json({ conflicts, total: conflicts.length })
    } catch (err) {
        logger.error({ err, sprintId }, 'GET /api/sprints/:id/conflicts failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Conflict detection failed' } })
    }
})

// ── GET /api/sprints/:id/logs ─────────────────────────────────────────────────
// Returns the activity log for a sprint, oldest-first.
// Used by the Control Room "Activity Log" tab.

sprintRunnerRouter.get('/:id/logs', async (req, res) => {
    const { id: sprintId } = req.params
    const { limit = '200' } = req.query as Record<string, string>

    try {
        const rows = await db.select().from(sprintLogs)
            .where(eq(sprintLogs.sprintId, sprintId))
            .orderBy(asc(sprintLogs.createdAt))
            .limit(Math.min(parseInt(limit, 10) || 200, 500))

        res.json({ logs: rows, total: rows.length })
    } catch (err) {
        logger.error({ err, sprintId }, 'GET /api/sprints/:id/logs failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch sprint logs' } })
    }
})
