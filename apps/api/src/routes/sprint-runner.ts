/**
 * Sprint engine API — start, status, task tree.
 *
 * POST /api/sprints/:id/run        Start sprint execution
 * GET  /api/sprints/:id/tasks      Sprint task tree with status
 * GET  /api/sprints/:id/conflicts  Conflict report for a sprint
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq } from '@plexo/db'
import { sprints, sprintTasks } from '@plexo/db'
import { runSprint } from '@plexo/agent/sprint/runner'
import { detectDynamicConflicts } from '@plexo/agent/sprint/conflicts'
import { logger } from '../logger.js'

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

    // Fire-and-forget — sprint runs async, SSE keeps client updated
    runSprint({
        sprintId,
        workspaceId,
        repo: sprint.repo ?? undefined,
        category: sprint.category ?? 'code',
        request: sprint.request,
    }).catch((err: unknown) => {
        logger.error({ err, sprintId }, 'Sprint run failed')
    })

    res.status(202).json({ sprintId, status: 'started', message: 'Sprint execution started — follow progress via SSE' })
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
