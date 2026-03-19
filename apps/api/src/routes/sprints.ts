// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, desc, eq, and, sprintStatusEnum } from '@plexo/db'
import { sprints, tasks } from '@plexo/db'
import { logger } from '../logger.js'
import { ulid } from 'ulid'
import { UUID_RE } from '../validation.js'

export const sprintsRouter: RouterType = Router()

const VALID_SPRINT_STATUSES = new Set<string>(sprintStatusEnum.enumValues)
const VALID_CATEGORIES = new Set(['code', 'research', 'writing', 'ops', 'data', 'marketing', 'general'])

// ── GET /api/sprints?workspaceId=&status= ───────────────────────────────────

sprintsRouter.get('/', async (req, res) => {
    const { workspaceId, status, limit = '25' } = req.query as Record<string, string>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (status && !VALID_SPRINT_STATUSES.has(status)) {
        res.status(400).json({ error: { code: 'INVALID_STATUS', message: `status must be one of: ${[...VALID_SPRINT_STATUSES].join(', ')}` } })
        return
    }

    try {
        const conditions: ReturnType<typeof eq>[] = [eq(sprints.workspaceId, workspaceId)]
        if (status) {
            conditions.push(eq(sprints.status, status as typeof sprints.$inferSelect.status))
        }

        const items = await db.select().from(sprints)
            .where(and(...conditions))
            .orderBy(desc(sprints.createdAt))
            .limit(Math.min(parseInt(limit, 10) || 25, 100))

        res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/sprints failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch sprints' } })
    }
})

// ── POST /api/sprints ────────────────────────────────────────────────────────

sprintsRouter.post('/', async (req, res) => {
    const { workspaceId, repo, request, category = 'code', metadata = {}, costCeilingUsd, perTaskCostCeiling, perTaskTokenBudget } = req.body as {
        workspaceId: string
        repo?: string
        request: string
        category?: string
        metadata?: Record<string, unknown>
        /** Max USD for the entire project. 0 = reject (nonsensical). null/undefined = no ceiling. */
        costCeilingUsd?: number
        /** Max USD per individual task. Propagated into each task at dispatch. */
        perTaskCostCeiling?: number
        /** Max output tokens per task. Propagated into each task at dispatch. */
        perTaskTokenBudget?: number
    }

    if (!workspaceId || !request) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId and request are required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (category && !VALID_CATEGORIES.has(category)) {
        res.status(400).json({ error: { code: 'INVALID_CATEGORY', message: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}` } })
        return
    }
    // repo is required only for code category
    if (category === 'code' && !repo) {
        res.status(400).json({ error: { code: 'MISSING_REPO', message: 'repo is required for code projects' } })
        return
    }
    if (repo && repo.length > 500) {
        res.status(400).json({ error: { code: 'INVALID_REPO', message: 'repo max 500 chars' } })
        return
    }
    if (request.length > 4000) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'request max 4000 chars' } })
        return
    }
    if (costCeilingUsd !== undefined && costCeilingUsd <= 0) {
        res.status(400).json({ error: { code: 'INVALID_BUDGET', message: 'costCeilingUsd must be > 0' } })
        return
    }
    if (perTaskCostCeiling !== undefined && perTaskCostCeiling <= 0) {
        res.status(400).json({ error: { code: 'INVALID_BUDGET', message: 'perTaskCostCeiling must be > 0' } })
        return
    }

    try {
        const id = ulid()
        // Merge per-task budget defaults into metadata so the sprint runner can propagate them
        const enrichedMetadata = {
            ...metadata,
            ...(perTaskCostCeiling != null ? { perTaskCostCeiling } : {}),
            ...(perTaskTokenBudget != null ? { perTaskTokenBudget } : {}),
        }
        const [sprint] = await db.insert(sprints).values({
            id,
            workspaceId,
            repo: repo ?? null,
            request,
            category,
            metadata: enrichedMetadata,
            status: 'planning',
            costCeilingUsd: costCeilingUsd ?? null,
        }).returning()

        res.status(201).json(sprint)
    } catch (err) {
        logger.error({ err }, 'POST /api/sprints failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create sprint' } })
    }
})

// ── GET /api/sprints/:id ─────────────────────────────────────────────────────

sprintsRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid sprint id' } })
        return
    }
    try {
        const [sprint] = await db.select().from(sprints).where(eq(sprints.id, id)).limit(1)
        if (!sprint) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
            return
        }
        // Tasks linked to sprint via project field — select key columns, cap at 200
        const sprintTasks = await db.select({
            id: tasks.id,
            type: tasks.type,
            status: tasks.status,
            source: tasks.source,
            outcomeSummary: tasks.outcomeSummary,
            qualityScore: tasks.qualityScore,
            costUsd: tasks.costUsd,
            createdAt: tasks.createdAt,
            completedAt: tasks.completedAt,
        }).from(tasks)
            .where(eq(tasks.project, id))
            .orderBy(desc(tasks.createdAt))
            .limit(200)
        res.json({ sprint, tasks: sprintTasks })
    } catch (err) {
        logger.error({ err }, 'GET /api/sprints/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch sprint' } })
    }
})

// ── PATCH /api/sprints/:id ───────────────────────────────────────────────────

sprintsRouter.patch('/:id', async (req, res) => {
    const { id } = req.params
    const { status } = req.body as { status?: string }

    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid sprint id' } })
        return
    }
    if (status && !VALID_SPRINT_STATUSES.has(status)) {
        res.status(400).json({ error: { code: 'INVALID_STATUS', message: `status must be one of: ${[...VALID_SPRINT_STATUSES].join(', ')}` } })
        return
    }

    try {
        const updates: Partial<typeof sprints.$inferInsert> = {}
        if (status) updates.status = status as typeof sprints.$inferInsert.status
        if (status === 'complete') updates.completedAt = new Date()

        const [updated] = await db.update(sprints)
            .set(updates)
            .where(eq(sprints.id, id))
            .returning()

        if (!updated) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
            return
        }
        res.json(updated)
    } catch (err) {
        logger.error({ err }, 'PATCH /api/sprints/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update sprint' } })
    }
})
