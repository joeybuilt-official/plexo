// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { inferKind, type WorkKind } from '@plexo/domain'
import * as tasksRepo from '../repositories/tasks.repository.js'
import { push, list, cancel as queueCancel } from '@plexo/queue'
import { getResumeStep } from '@plexo/agent/executor/step-builder'
import { resolveDecision, getDecision, type PendingDecision } from '@plexo/agent/one-way-door'
import { logger } from '../logger.js'
import { emitToWorkspace } from '../sse-emitter.js'
import { cancelActiveTask } from '../agent-loop.js'
import { trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { audit } from '../audit.js'
import { recordConversation } from '../conversation-log.js'
import type { Request, Response } from 'express'

export const tasksRouter: RouterType = Router()

/** Look up a task's workspace id and verify caller has access. */
async function ensureTaskWorkspaceAccess(req: Request, res: Response, taskId: string): Promise<boolean> {
    const row = await tasksRepo.getTaskWorkspaceId(taskId)
    if (!row) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
        return false
    }
    return ensureWorkspaceAccess(req, res, row.workspaceId)
}


const VALID_TASK_TYPES = new Set(['coding', 'deployment', 'research', 'ops', 'opportunity', 'monitoring', 'report', 'online', 'automation'])
const VALID_TASK_SOURCES = new Set(['telegram', 'slack', 'discord', 'scanner', 'github', 'cron', 'dashboard', 'api', 'extension', 'sentry'])

// ── GET /api/tasks?workspaceId=&status=&type=&limit=&cursor= ─────────────────

tasksRouter.get('/', async (req, res) => {
    const {
        workspaceId,
        status,
        type,
        projectId,
        parentId,
        limit = '25',
        cursor,
    } = req.query as Record<string, string>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.json({ items: [], nextCursor: null, total: 0 })
        return
    }
    if (projectId && !UUID_RE.test(projectId)) {
        res.json({ items: [], nextCursor: null, total: 0 })
        return
    }
    if (parentId && !UUID_RE.test(parentId)) {
        res.json({ items: [], nextCursor: null, total: 0 })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // Comma-separated `status` (e.g. ?status=queued,running) maps a single UI
    // tab to multiple statuses. Single value falls through as a plain string.
    const statusFilter: string | string[] | undefined = status
        ? (status.includes(',') ? status.split(',').map(s => s.trim()).filter(Boolean) : status)
        : undefined

    try {
        const items = await list({
            workspaceId,
            status: statusFilter,
            type: type ?? undefined,
            projectId: projectId ?? undefined,
            parentId: parentId ?? undefined,
            limit: Math.min(parseInt(limit, 10) || 25, 100),
            cursor: cursor ?? undefined,
        })

        const nextCursor = items.length === (parseInt(limit, 10) || 25)
            ? items[items.length - 1]?.id ?? null
            : null

        res.json({ items, nextCursor, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/tasks failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch tasks' } })
    }
})

// ── POST /api/tasks ──────────────────────────────────────────────────────────

tasksRouter.post('/', async (req, res) => {
    const { workspaceId, type, source = 'api', context = {}, priority, projectId } = req.body as {
        workspaceId: string
        type: string
        source?: string
        context?: Record<string, unknown>
        priority?: number
        projectId?: string
    }

    if (!workspaceId || !type) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId and type are required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!VALID_TASK_TYPES.has(type)) {
        res.status(400).json({ error: { code: 'INVALID_TYPE', message: `type must be one of: ${[...VALID_TASK_TYPES].join(', ')}` } })
        return
    }
    if (!VALID_TASK_SOURCES.has(source)) {
        res.status(400).json({ error: { code: 'INVALID_SOURCE', message: `source must be one of: ${[...VALID_TASK_SOURCES].join(', ')}` } })
        return
    }
    if (projectId && !UUID_RE.test(projectId)) {
        res.status(400).json({ error: { code: 'INVALID_PROJECT', message: 'Valid UUID required for projectId' } })
        return
    }
    if (priority !== undefined && (typeof priority !== 'number' || priority < 1 || priority > 10)) {
        res.status(400).json({ error: { code: 'INVALID_PRIORITY', message: 'priority must be 1–10' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const id = await push({
            workspaceId,
            type: type as Parameters<typeof push>[0]['type'],
            source: source as Parameters<typeof push>[0]['source'],
            // Connection & Profile Standard (ADR 0001 §3): stamp the dispatching app's
            // identity from the service-key context (anti-spoof: overrides any
            // client-supplied context.appId). Undefined for session/dashboard callers.
            context: req.serviceContext?.appId ? { ...context, appId: req.serviceContext.appId } : context,
            priority,
            projectId,
        })
        emitToWorkspace(workspaceId, { type: 'task_queued', taskId: id, source })
        trackEvent('task.queued', 'info', { taskId: id, type, source, workspaceId })
        audit(req, { workspaceId, userId: req.user?.id, action: 'task.create', resource: 'tasks', resourceId: id, metadata: { type, source } })

        // Record a conversation entry for dashboard-sourced tasks so they
        // appear on the Conversations page alongside Telegram threads.
        if (source === 'dashboard') {
            const msg = typeof context.description === 'string' ? context.description : ''
            if (msg) {
                void recordConversation({
                    workspaceId,
                    source: 'dashboard',
                    message: msg,
                    status: 'pending',
                    intent: 'TASK',
                    taskId: id,
                }).catch(err => logger.warn({ err, taskId: id }, 'recordConversation failed'))
            }
        }

        res.status(201).json({ id })
    } catch (err) {
        logger.error({ err }, 'POST /api/tasks failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create task' } })
    }
})

// ── GET /api/tasks/:id ───────────────────────────────────────────────────────

tasksRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        const task = await tasksRepo.getTaskById(id)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, task.workspaceId)) return
        const stepsQuery = tasksRepo.selectTaskSteps(id)

        // Lifecycle timeline (Phase F2). Filtered by both taskId AND
        // workspaceId — defense in depth so a guessable task id can't
        // surface another workspace's events.
        const eventsQuery = tasksRepo.selectTaskEvents(id, task.workspaceId)

        // Phase K (Item 21): collapse the awaiting-approval Redis lookup into the
        // same Promise.all as steps/events so all three round-trips run in
        // parallel. Non-awaiting tasks pass `null` and skip the Redis hop.
        const ctxApprovalId = (task.status === 'awaiting_approval'
            && task.context && typeof task.context === 'object'
            && '_approvalId' in task.context
            && typeof (task.context as Record<string, unknown>)._approvalId === 'string'
            && ((task.context as Record<string, unknown>)._approvalId as string).length > 0)
            ? (task.context as Record<string, unknown>)._approvalId as string
            : null

        const decisionPromise: Promise<PendingDecision | null> = ctxApprovalId
            ? getDecision(ctxApprovalId).catch((err) => {
                logger.warn({ err, taskId: id, approvalId: ctxApprovalId }, 'getDecision failed; returning approval=null')
                return null
            })
            : Promise.resolve(null)

        const [steps, eventRows, approval] = await Promise.all([
            stepsQuery,
            eventsQuery,
            decisionPromise,
        ])
        const events = eventRows.map(r => ({
            id: r.id,
            eventType: r.eventType,
            fromState: r.fromState,
            toState: r.toState,
            metadata: r.metadata,
            recordedAt: r.recordedAt.toISOString(),
        }))

        res.json({ task, steps, events, approval })
    } catch (err) {
        logger.error({ err }, 'GET /api/tasks/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch task' } })
    }
})

// ── GET /api/tasks/:id/steps/raw ─────────────────────────────────────────────
// Phase 5 of intelligence-hardening — task debug viewer.
//
// Returns the raw `task_steps.stepState` JSONB per step for a workspace-scoped
// task so the `/app/tasks/[id]` debug panel can render it inline instead of
// making the user grep container logs. Workspace-member gated via the same
// `ensureTaskWorkspaceAccess` helper the rest of this router uses.
//
// Capped at 200 rows — typical tasks have 3–25 steps; anything beyond 200 is
// a runaway and `truncated: true` surfaces the cap to the caller so the UI
// can show a "results truncated" hint. No pagination — this is a debug view,
// not a production table.
const RAW_STEPS_LIMIT = 200
tasksRouter.get('/:id/steps/raw', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    if (!await ensureTaskWorkspaceAccess(req, res, id)) return

    try {
        const rows = await tasksRepo.getRawTaskSteps(id, RAW_STEPS_LIMIT)

        res.json({
            taskId: id,
            steps: rows,
            total: rows.length,
            truncated: rows.length === RAW_STEPS_LIMIT,
        })
    } catch (err) {
        logger.error({ err, id }, 'GET /api/tasks/:id/steps/raw failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch raw step state' } })
    }
})

// ── DELETE /api/tasks/:id ────────────────────────────────────────────────────

tasksRouter.delete('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        // Fetch workspace id before we tombstone the row (for SSE emit)
        const existing = await tasksRepo.getTaskWorkspaceAndStatus(id)

        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, existing.workspaceId)) return

        // Only cancel if task is in a cancellable state — don't overwrite complete/failed/cancelled
        if (!['queued', 'claimed', 'running', 'blocked', 'failed', 'awaiting_approval'].includes(existing.status)) {
            res.status(409).json({ error: { code: 'NOT_CANCELLABLE', message: `Task is already ${existing.status}` } })
            return
        }

        await queueCancel(id)

        // Signal the executor immediately if this task is currently running
        const aborted = cancelActiveTask(id)
        logger.info({ taskId: id, aborted }, 'Task cancelled')

        emitToWorkspace(existing.workspaceId, { type: 'task_cancelled', taskId: id })
        trackEvent('task.cancelled', 'warning', { taskId: id, workspaceId: existing.workspaceId, previousStatus: existing.status })
        audit(req, { workspaceId: existing.workspaceId, userId: req.user?.id, action: 'task.cancel', resource: 'tasks', resourceId: id })
        res.json({ ok: true, aborted })
    } catch (err) {
        logger.error({ err }, 'DELETE /api/tasks/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to cancel task' } })
    }
})

// ── POST /api/tasks/:id/confirm ──────────────────────────────────────────────
// Phase 5 — task UI surface for the OWD/awaiting_approval pipeline.
// Reads `tasks.context._approvalId` (set by the agent loop when the task
// transitions to awaiting_approval) and resolves it via the same one-way-door
// resolveDecision that powers chat-channel CONFIRM/CANCEL.

tasksRouter.post('/:id/confirm', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        const task = await tasksRepo.getTaskWorkspaceStatusContext(id)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, task.workspaceId)) return
        if (task.status !== 'awaiting_approval') {
            res.status(409).json({ error: { code: 'NOT_AWAITING', message: `Task is ${task.status}, not awaiting confirmation` } })
            return
        }
        const ctx = (task.context ?? {}) as Record<string, unknown>
        const approvalId = typeof ctx._approvalId === 'string' ? ctx._approvalId : null
        if (!approvalId) {
            res.status(409).json({ error: { code: 'NO_APPROVAL', message: 'Task has no pending approval id' } })
            return
        }
        const decidedBy = (req.body as { user?: string } | undefined)?.user ?? req.user?.email ?? 'dashboard'
        const updated = await resolveDecision(approvalId, 'approved', decidedBy)
        if (!updated) {
            res.status(409).json({ error: { code: 'ALREADY_RESOLVED', message: 'Approval expired or already resolved' } })
            return
        }
        emitToWorkspace(task.workspaceId, { type: 'owd_approved', id: updated.id, taskId: id, operation: updated.operation })
        trackEvent('task.confirmed', 'info', { taskId: id, approvalId: updated.id, decidedBy, workspaceId: task.workspaceId })
        audit(req, { workspaceId: task.workspaceId, userId: req.user?.id, action: 'task.confirm', resource: 'tasks', resourceId: id, metadata: { approvalId: updated.id } })
        res.json({ ok: true, approval: updated })
    } catch (err) {
        logger.error({ err, id }, 'POST /api/tasks/:id/confirm failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to confirm task' } })
    }
})

// ── POST /api/tasks/:id/cancel ───────────────────────────────────────────────
// Phase 5 — POST alias of DELETE /api/tasks/:id matching the project-system
// spec. When the task is awaiting_approval, also rejects the underlying OWD
// so a paused executor unblocks immediately rather than timing out.

tasksRouter.post('/:id/cancel', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        const existing = await tasksRepo.getTaskWorkspaceStatusContext(id)
        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, existing.workspaceId)) return
        if (!['queued', 'claimed', 'running', 'blocked', 'failed', 'awaiting_approval'].includes(existing.status)) {
            res.status(409).json({ error: { code: 'NOT_CANCELLABLE', message: `Task is already ${existing.status}` } })
            return
        }

        // Order matters: queueCancel must run BEFORE resolveDecision so the
        // OWD_RESOLVED bus listener (registered when OWD_RELEASE_SLOT='planner_only')
        // finds the row already in 'cancelled' state and skips its
        // markTaskFailed call. Otherwise the in-process EventEmitter delivers
        // synchronously and the listener flips status to 'failed' before
        // queueCancel runs, contradicting the user's cancel intent.
        await queueCancel(id)

        if (existing.status === 'awaiting_approval') {
            const ctx = (existing.context ?? {}) as Record<string, unknown>
            const approvalId = typeof ctx._approvalId === 'string' ? ctx._approvalId : null
            if (approvalId) {
                try {
                    const decidedBy = (req.body as { user?: string } | undefined)?.user ?? req.user?.email ?? 'dashboard'
                    await resolveDecision(approvalId, 'rejected', decidedBy)
                } catch (owdErr) {
                    logger.warn({ err: owdErr, taskId: id }, 'resolveDecision(rejected) failed during task cancel — proceeding')
                }
            }
        }
        const aborted = cancelActiveTask(id)
        emitToWorkspace(existing.workspaceId, { type: 'task_cancelled', taskId: id })
        trackEvent('task.cancelled', 'warning', { taskId: id, workspaceId: existing.workspaceId, previousStatus: existing.status })
        audit(req, { workspaceId: existing.workspaceId, userId: req.user?.id, action: 'task.cancel', resource: 'tasks', resourceId: id })
        res.json({ ok: true, aborted })
    } catch (err) {
        logger.error({ err, id }, 'POST /api/tasks/:id/cancel failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to cancel task' } })
    }
})

// ── POST /api/tasks/:id/retry ─────────────────────────────────────────────────
// FUN-014: Resume from checkpoint on retry. Finds the last completed step from
// the original task and passes resumeFromTaskId + resumeFromStep in the new
// task's context so the executor rebuilds conversation history and skips
// already-completed work.

tasksRouter.post('/:id/retry', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        const task = await tasksRepo.getTaskById(id)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, task.workspaceId)) return
        if (task.status !== 'blocked' && task.status !== 'cancelled' && task.status !== 'failed') {
            res.status(400).json({ error: { code: 'NOT_RETRYABLE', message: 'Only blocked, failed, or cancelled tasks can be retried' } })
            return
        }

        // FUN-014: Check for a checkpoint to resume from
        let resumeFromStep = 0
        try {
            resumeFromStep = await getResumeStep(id)
            // -1 means task was terminal (already done) — no resume needed
            if (resumeFromStep < 0) resumeFromStep = 0
        } catch {
            // Non-fatal: fall back to fresh start
            resumeFromStep = 0
        }

        const originalContext = (task.context as Record<string, unknown>) ?? {}

        // Re-queue with same parameters + checkpoint metadata
        const newId = await push({
            workspaceId: task.workspaceId,
            type: task.type as Parameters<typeof push>[0]['type'],
            source: (task.source ?? 'api') as Parameters<typeof push>[0]['source'],
            context: {
                ...originalContext,
                // Checkpoint resume: the executor checks these fields to rebuild
                // message history from the original task's persisted steps
                ...(resumeFromStep > 0 ? {
                    resumeFromTaskId: id,
                    resumeFromStep,
                } : {}),
            },
            projectId: task.projectId ?? undefined,
        })

        // Cancel the blocked original (failed/cancelled are no-ops since queueCancel
        // only transitions cancellable states — exactly what we want here).
        await queueCancel(id)

        trackEvent('task.retry', 'info', {
            originalId: id,
            newId,
            type: task.type,
            source: task.source,
            workspaceId: task.workspaceId,
            resumeFromStep,
        })
        logger.info({ originalId: id, newId, resumeFromStep }, 'Task retried with checkpoint resume')
        res.status(201).json({ id: newId, resumeFromStep })
    } catch (err) {
        logger.error({ err }, 'POST /api/tasks/:id/retry failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retry task' } })
    }
})

// ── GET /api/tasks/:id/assets ──────────────────────────────────────────────
// Lists agent-produced assets for a task. 
// Prioritizes versioned artifacts from DB (Phase 4), falls back to /tmp filesystem.
tasksRouter.get('/:id/assets', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    if (!await ensureTaskWorkspaceAccess(req, res, id)) return

    try {
        // 1. Fetch from DB first (Phase 4 + Phase 2 works taxonomy)
        const dbArtifacts = await tasksRepo.getTaskArtifacts(id)

        if (dbArtifacts.length > 0) {
            res.json({
                items: dbArtifacts.map(a => {
                    // Phase 2: fall back to inference for pre-kind rows.
                    const kind: WorkKind = (a.kind as WorkKind | null) ?? inferKind(a.filename, a.content ?? undefined).kind
                    return {
                        artifactId: a.id,
                        filename: a.filename,
                        type: a.type,          // legacy
                        kind,                  // Phase 2 canonical
                        meta: (a.meta as Record<string, unknown> | null) ?? {},
                        bytes: Buffer.byteLength(a.content || ''),
                        isText: true,
                        content: a.content,
                        version: a.currentVersion,
                        updatedAt: a.updatedAt,
                    }
                })
            })
            return
        }

        // 2. Fallback to /tmp filesystem (Phase 1)
        const { readdir, stat: fsStat, readFile } = (await import('node:fs')).promises
        const { join, extname } = await import('node:path')

        const dir = `/tmp/plexo-assets/${id}`
        const files = await readdir(dir).catch(() => null)
        if (files === null) {
            res.json({ items: [] })
            return
        }

        const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.csv', '.html', '.xml', '.yaml', '.yml', '.toml', '.sh', '.py', '.ts', '.js', '.sql', '.mermaid', '.mmd'])
        const MAX_INLINE = 5 * 1024 * 1024 // 5MB for DB-backed

        const items = await Promise.all(files.map(async (filename) => {
            const filePath = join(dir, filename)
            const stat = await fsStat(filePath)
            const ext = extname(filename).toLowerCase()
            const isText = TEXT_EXTS.has(ext)
            let content: string | null = null
            if (isText && stat.size <= MAX_INLINE) {
                try {
                    content = await readFile(filePath, 'utf8')
                } catch { /* skip */ }
            }
            // Phase 2: infer kind from filename + content for /tmp fallback.
            const inferred = inferKind(filename, content ?? undefined)
            return {
                filename,
                kind: inferred.kind,
                meta: inferred.language ? { language: inferred.language } : {},
                bytes: stat.size,
                isText,
                content,
                path: filePath,
            }
        }))

        res.json({ items })
    } catch (err) {
        logger.error({ err, id }, 'GET /api/tasks/:id/assets failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list assets' } })
    }
})

// ── GET /api/tasks/:id/artifacts/:artifactId/versions ───────────────────────
// Returns version history for a specific artifact.
tasksRouter.get('/:id/artifacts/:artifactId/versions', async (req, res) => {
    const { id, artifactId } = req.params
    if (!UUID_RE.test(artifactId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for artifactId' } })
        return
    }
    if (!await ensureTaskWorkspaceAccess(req, res, id)) return
    try {
        const versions = await tasksRepo.getArtifactVersions(artifactId)

        res.json({ versions })
    } catch (err) {
        logger.error({ err, artifactId }, 'GET artifact versions failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch version history' } })
    }
})

// ── GET /api/tasks/:id/artifacts/:artifactId/versions/:version ──────────────
// Returns a specific version of an artifact.
tasksRouter.get('/:id/artifacts/:artifactId/versions/:version', async (req, res) => {
    const { id, artifactId, version } = req.params
    if (!UUID_RE.test(artifactId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for artifactId' } })
        return
    }
    if (!await ensureTaskWorkspaceAccess(req, res, id)) return
    const versionNum = parseInt(version, 10)
    if (isNaN(versionNum) || versionNum < 0) {
        res.status(400).json({ error: { code: 'INVALID_VERSION', message: 'version must be a non-negative integer' } })
        return
    }
    try {
        const ver = await tasksRepo.getArtifactVersion(artifactId, versionNum)

        if (!ver) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Version not found' } })
            return
        }

        res.json({ version: ver })
    } catch (err) {
        logger.error({ err, artifactId, version }, 'GET artifact version failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch version' } })
    }
})

// ── POST /api/tasks/:id/assets/export ──────────────────────────────────────────────
// Exports a text asset to PDF or DOCX format.

tasksRouter.post('/:id/assets/export', async (req, res) => {
    const { id } = req.params
    const { filename, format } = req.body as { filename: string, format: 'pdf' | 'docx' }

    if (!id || !filename || !format) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'id, filename, and format are required' } })
        return
    }
    if (format !== 'pdf' && format !== 'docx') {
        res.status(400).json({ error: { code: 'UNSUPPORTED_FORMAT', message: 'format must be "pdf" or "docx"' } })
        return
    }
    if (!await ensureTaskWorkspaceAccess(req, res, id)) return

    try {
        const { readFile: fsReadFile } = (await import('node:fs')).promises
        // @ts-ignore
        const { join, resolve } = await import('node:path')

        const baseDir = resolve(`/tmp/plexo-assets/${id}`)
        const filePath = resolve(join(baseDir, filename))
        // Path traversal protection: ensure resolved path stays within the task's asset directory
        if (!filePath.startsWith(baseDir + '/') && filePath !== baseDir) {
            res.status(400).json({ error: { code: 'INVALID_PATH', message: 'Invalid filename' } })
            return
        }

        let content: string
        try {
            content = await fsReadFile(filePath, 'utf8')
        } catch {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } })
            return
        }
        
        if (format === 'pdf') {
            const { marked, Renderer } = await import('marked')
            const puppeteer = await import('puppeteer')

            // Strip raw HTML blocks and dangerous inline HTML from markdown output
            // to prevent XSS/script execution inside Puppeteer's headless Chrome.
            const safeRenderer = new Renderer()
            safeRenderer.html = () => ''
            marked.use({ renderer: safeRenderer })

            const rawHtml = await marked.parse(content)
            // Belt-and-suspenders: strip any residual script/event-handler patterns
            const htmlContent = rawHtml
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
                .replace(/javascript\s*:/gi, 'blocked:')
            const wrappedHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 2em; max-width: 800px; margin: 0 auto; color: #333; }
                    code { background: #f4f4f4; padding: 0.2em 0.4em; border-radius: 3px; font-family: monospace; }
                    pre { background: #f4f4f4; padding: 1em; border-radius: 5px; overflow-x: auto; font-family: monospace; }
                    blockquote { border-left: 4px solid #ccc; padding-left: 1em; color: #666; }
                    h1, h2, h3, h4 { color: #111; border-bottom: 1px solid #eaeaea; padding-bottom: 0.3em; }
                    img { max-width: 100%; }
                </style>
            </head>
            <body>
                ${htmlContent}
            </body>
            </html>
            `
            
            const browser = await puppeteer.default.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
            const page = await browser.newPage()
            await page.setContent(wrappedHtml, { waitUntil: 'load' })
            const pdfBuffer = await page.pdf({ format: 'A4', margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' } })
            await browser.close()
            
            res.setHeader('Content-Type', 'application/pdf')
            const safeName = filename.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')
            res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`)
            res.send(Buffer.from(pdfBuffer))
            return
        }
        
        if (format === 'docx') {
            const { Document, Packer, Paragraph, TextRun } = await import('docx')
            
            // Naive plain text fallback wrapper
            const lines = content.split('\n')
            
            const doc = new Document({
                sections: [{
                    properties: {},
                    children: lines.map((line: string) => new Paragraph({
                        children: [
                            new TextRun(line)
                        ],
                    })),
                }],
            })
            
            const b64string = await Packer.toBase64String(doc)
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
            const safeDocxName = filename.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')
            res.setHeader('Content-Disposition', `attachment; filename="${safeDocxName}.docx"`)
            res.send(Buffer.from(b64string, 'base64'))
            return
        }

        res.status(400).json({ error: { code: 'UNSUPPORTED_FORMAT', message: 'Unsupported format' } })
    } catch (err) {
        logger.error({ err, id }, 'POST /api/tasks/:id/assets/export failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to export asset' } })
    }
})


tasksRouter.get('/stats/summary', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }

    if (!UUID_RE.test(workspaceId)) {
        res.json({ byStatus: {}, cost: { total: 0, thisWeek: 0, ceiling: parseFloat(process.env.API_COST_CEILING_USD ?? '10') } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const rows = await tasksRepo.getTaskStatusCounts(workspaceId)

        const stats: Record<string, number> = {}
        for (const row of rows) {
            stats[row.status] = parseInt(row.count, 10)
        }

        const costCeiling = parseFloat(process.env.API_COST_CEILING_USD ?? '10')
        const weekCostRow = await tasksRepo.getWeekCost(workspaceId)
        const allTimeCostRow = await tasksRepo.getAllTimeCost(workspaceId)

        res.json({
            byStatus: stats,
            cost: {
                total: parseFloat(allTimeCostRow?.total ?? '0'),
                thisWeek: parseFloat(weekCostRow?.cost_usd ?? '0'),
                ceiling: costCeiling,
            },
        })
    } catch (err) {
        logger.error({ err }, 'GET /api/tasks/stats failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch stats' } })
    }
})

// ── PATCH /api/v1/tasks/:id/artifacts/:artifactId/meta ─────────────────
// Shallow-merges a patch into artifacts.meta JSONB. Used by interactive
// renderers (checklist toggle, table filter prefs, etc.) to persist
// client-side state back to the row without bumping the version history.
//
// Request body: { patch: Record<string, unknown> }
// Response:     { meta: Record<string, unknown> }
tasksRouter.patch('/:id/artifacts/:artifactId/meta', async (req, res) => {
    const { id, artifactId } = req.params
    const { patch } = req.body as { patch?: Record<string, unknown> }
    if (!id) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    // artifacts.id is a ulid-text, not a uuid — just sanity-check length.
    if (!artifactId || artifactId.length > 64 || artifactId.length < 8) {
        res.status(400).json({ error: { code: 'INVALID_ARTIFACT_ID', message: 'Invalid artifact id' } })
        return
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        res.status(400).json({ error: { code: 'INVALID_PATCH', message: 'patch object required' } })
        return
    }
    const patchSize = JSON.stringify(patch).length
    if (patchSize > 16 * 1024) {
        res.status(400).json({ error: { code: 'PATCH_TOO_LARGE', message: 'patch exceeds 16KB' } })
        return
    }
    if (!await ensureTaskWorkspaceAccess(req, res, id)) return

    try {
        const art = await tasksRepo.getArtifactForMeta(artifactId)
        if (!art || art.taskId !== id) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Artifact not found on this task' } })
            return
        }
        const merged = {
            ...((art.meta as Record<string, unknown> | null) ?? {}),
            ...patch,
        }
        const updated = await tasksRepo.updateArtifactMeta(artifactId, merged)
        res.json({ meta: updated?.meta ?? merged })
    } catch (err) {
        logger.error({ err, artifactId }, 'PATCH artifact meta failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update meta' } })
    }
})
