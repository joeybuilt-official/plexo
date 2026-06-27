// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { eq } from 'drizzle-orm'
import { sprintStatusEnum } from '@plexo/db'
import { sprints } from '@plexo/db'
import * as sprintsRepo from '../repositories/sprints.repository.js'
import { logger } from '../logger.js'
import { ulid } from 'ulid'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { nameProject } from '../channel-ai.js'

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
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const conditions: ReturnType<typeof eq>[] = [eq(sprints.workspaceId, workspaceId)]
        if (status) {
            conditions.push(eq(sprints.status, status as typeof sprints.$inferSelect.status))
        }

        const items = await sprintsRepo.listSprints(conditions, Math.min(parseInt(limit, 10) || 25, 100))

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
    if (category === 'code' && process.env.ENABLE_SPRINT_CODING_TASKS !== 'true') {
        res.status(503).json({ error: { code: 'SPRINT_CODING_DISABLED', message: 'Sprint coding tasks are disabled on this instance. Set ENABLE_SPRINT_CODING_TASKS=true to enable; see docs/operations/sprint-coding-flag.md.' } })
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
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const id = ulid()
        // Merge per-task budget defaults into metadata so the sprint runner can propagate them
        const enrichedMetadata: Record<string, unknown> = {
            ...metadata,
            ...(perTaskCostCeiling != null ? { perTaskCostCeiling } : {}),
            ...(perTaskTokenBudget != null ? { perTaskTokenBudget } : {}),
        }
        // Official project name — generated unless the caller supplied one.
        if (typeof enrichedMetadata.name !== 'string' || enrichedMetadata.name.trim().length === 0) {
            enrichedMetadata.name = await nameProject(workspaceId, request)
        }
        const sprint = await sprintsRepo.insertSprint({
            id,
            workspaceId,
            repo: repo ?? null,
            request,
            category,
            metadata: enrichedMetadata,
            status: 'planning',
            costCeilingUsd: costCeilingUsd ?? null,
        })

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
        const sprint = await sprintsRepo.getSprint(id)
        if (!sprint) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, sprint.workspaceId)) return
        // Tasks linked to sprint via project field — select key columns, cap at 200
        const sprintTasks = await sprintsRepo.listTasksForSprintProject(id)
        res.json({ sprint, tasks: sprintTasks, criticalPath: null })
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
        const existing = await sprintsRepo.getSprintWorkspaceId(id)
        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sprint not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, existing.workspaceId)) return

        const updates: Partial<typeof sprints.$inferInsert> = {}
        if (status) updates.status = status as typeof sprints.$inferInsert.status
        if (status === 'complete') updates.completedAt = new Date()

        const updated = await sprintsRepo.updateSprintReturning(id, updates)

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
