// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { type AuthUserPayload } from '@plexo/auth'
import * as workspacesRepo from '../repositories/workspaces.repository.js'
import { trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { getAuth } from '../middleware/better-auth.js'
import { cancelActiveTask } from '../agent-loop.js'
import { deleteByPrefix } from '@plexo/storage'
import { logger } from '../logger.js'

export const workspacesRouter: RouterType = Router()


// GET /api/workspaces — list workspaces the caller is a member of
workspacesRouter.get('/', async (req, res) => {
    if (!req.user?.id) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
        return
    }

    try {
        // Super admins see everything; members see only their workspaces.
        const isSuperAdmin = req.user.isSuperAdmin
        const memberWorkspaceIds = isSuperAdmin
            ? null
            : await workspacesRepo.listMemberWorkspaceIds(req.user.id)

        if (memberWorkspaceIds !== null && memberWorkspaceIds.length === 0) {
            res.json({ items: [], total: 0 })
            return
        }

        const rows = await workspacesRepo.listSummaries(memberWorkspaceIds)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, '[workspaces.list] failed to list workspaces')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list workspaces' } })
    }
})

// GET /api/workspaces/:id
workspacesRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, id)) return
    try {
        const ws = await workspacesRepo.getById(id)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }
        // Strip aiProviders from settings — credentials are only served (redacted) via
        // GET /api/workspaces/:id/ai-providers to prevent plaintext key exposure.
        const { aiProviders: _omitted, ...safeSettings } = (ws.settings ?? {}) as Record<string, unknown>
        res.json({ ...ws, settings: safeSettings })
    } catch (err) {
        logger.error({ err, id }, '[workspaces.get] failed to get workspace')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get workspace' } })
    }
})

// POST /api/workspaces — create a new workspace. Caller becomes the owner
// and the first member automatically.
workspacesRouter.post('/', async (req, res) => {
    const { name, ownerId: bodyOwnerId } = req.body as { name?: string; ownerId?: string }
    if (!name?.trim()) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'name is required' } })
        return
    }
    if (name.trim().length > 200) {
        res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name max 200 chars' } })
        return
    }
    // Prefer the authenticated caller as owner. Fall back to body ownerId
    // ONLY for super admins so operators can still provision workspaces
    // on behalf of other users.
    const ownerId = req.user?.isSuperAdmin && bodyOwnerId ? bodyOwnerId : req.user?.id
    if (!ownerId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
        return
    }
    if (!UUID_RE.test(ownerId)) {
        res.status(400).json({ error: { code: 'INVALID_OWNER', message: 'Valid UUID required for ownerId' } })
        return
    }

    // Backstop for Phase H Stage 2: Better Auth's post-commit `user.create.after`
    // hook may have failed (or not run yet) so public.users could be missing the
    // owner row, which would break the workspaces.owner_id FK. Re-fetch the
    // authoritative auth user payload via getSession and mirror it inside the
    // same tx as the workspace insert. ON CONFLICT DO NOTHING makes this a
    // no-op when the hook already mirrored. See
    // ops/coreaudit/post-audit/adr/0001-post-audit-strategy.md.
    let ownerMirror: AuthUserPayload | null = null
    if (!req.user?.isSuperAdmin || ownerId === req.user?.id) {
        try {
            const incomingHeaders = new Headers()
            if (req.headers.authorization) incomingHeaders.set('authorization', req.headers.authorization)
            if (req.headers.cookie) incomingHeaders.set('cookie', req.headers.cookie)
            const session = await getAuth().api.getSession({ headers: incomingHeaders })
            const u = session?.user
            if (u && u.id === ownerId) {
                ownerMirror = {
                    id: u.id,
                    name: u.name,
                    email: u.email,
                    emailVerified: u.emailVerified,
                    createdAt: u.createdAt,
                    updatedAt: u.updatedAt,
                    image: (u as { image?: string | null }).image ?? null,
                }
            }
        } catch (err) {
            logger.warn({ err, ownerId }, '[workspaces.create] failed to fetch auth session for owner mirror; relying on prior hook mirror')
        }
    }

    try {
        const created = await workspacesRepo.createWithOwner({ name: name.trim(), ownerId, ownerMirror })

        if (!created) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
            return
        }

        // Phase C1 (ADR 0022) shadow-write — owner seed on POST /workspaces.

        res.status(201).json(created)
    } catch (err) {
        logger.error({ err, ownerId }, '[workspaces.create] failed to create workspace')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
    }
})

// DELETE /api/workspaces/:id — permanently delete a workspace (cascades to all child rows)
workspacesRouter.delete('/:id', async (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, id)) return
    if (req.workspaceRole && !['owner', 'admin'].includes(req.workspaceRole)) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only workspace owners/admins can delete' } })
        return
    }
    try {
        // Guard: refuse to delete the last remaining workspace
        const ids = await workspacesRepo.listIds(2)
        if (ids.length <= 1) {
            res.status(409).json({ error: { code: 'LAST_WORKSPACE', message: 'Cannot delete the last workspace' } })
            return
        }

        if (!await workspacesRepo.exists(id)) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        // Cancel any running tasks before deleting workspace — prevents ghost executors
        const runningTaskIds = await workspacesRepo.listRunningTaskIds(id)
        for (const taskId of runningTaskIds) {
            cancelActiveTask(taskId)
        }

        // FUN-009: Clean up S3 objects before DB cascade
        // Delete memory attachments (keyed by workspace ID)
        await deleteByPrefix(`memory/${id}/`).catch(err => logger.warn({ err }, 'S3 memory cleanup failed'))
        // Delete task assets (keyed by task ID — collect all task IDs for this workspace)
        const allTaskIds = await workspacesRepo.listAllTaskIds(id)
        await Promise.allSettled(
            allTaskIds.map(taskId => deleteByPrefix(`tasks/${taskId}/`).catch(err => logger.warn({ err, taskId }, 'S3 task cleanup failed')))
        )

        await workspacesRepo.deleteById(id)
        trackEvent('workspace.deleted', 'warning', { workspaceId: id })
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, id }, '[workspaces.delete] failed to delete workspace')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete workspace' } })
    }
})

// Settings keys that are INFRASTRUCTURE — agent tools must not modify them.
// These are only writable from the dashboard UI or dedicated endpoints (voice, intelligence).
// If X-Plexo-Source: agent is present, these keys are silently stripped.
const AGENT_PROTECTED_SETTINGS_KEYS = new Set([
    'systemPromptExtra',                  // operator-only system prompt injection
    'voice',                              // Deepgram API key + voice config (use /api/voice/settings)
    'aiProviders',                        // legacy provider config
    'defaultModel',                       // model selection
    'intelligenceSettings',               // inference mode, cost ceilings, routing
    'readOnlyMode',                       // safety mode toggle
    'safeMode',                           // safety mode toggle
    'requireApprovalForGeneralTasks',     // CONFIRM gate — agent must not disable its own approval requirement
    'escalationTimeoutHours',             // CONFIRM gate — agent must not extend its own approval window
])

// PATCH /api/workspaces/:id — update name and/or settings (deep-merges settings)
workspacesRouter.patch('/:id', async (req, res) => {
    const { id } = req.params
    let { name, settings } = req.body as { name?: string; settings?: Record<string, unknown> }

    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, id)) return
    if (name && name.length > 200) {
        res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name max 200 chars' } })
        return
    }

    // ── Agent source guard: strip infrastructure keys ─────────────────────
    // When the request comes from agent tools (X-Plexo-Source: agent),
    // silently strip protected keys to prevent capability sabotage.
    const isAgentSource = req.headers['x-plexo-source'] === 'agent'
    if (isAgentSource && settings) {
        const stripped: string[] = []
        for (const key of AGENT_PROTECTED_SETTINGS_KEYS) {
            if (key in settings) {
                delete settings[key]
                stripped.push(key)
            }
        }
        if (stripped.length > 0) {
            logger.warn({ workspaceId: id, stripped }, 'Agent attempted to modify protected settings keys — stripped')
        }
        // If nothing left after stripping, settings becomes empty
        if (Object.keys(settings).length === 0) settings = undefined
    }

    try {
        if (!name && settings === undefined) {
            res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'name or settings required' } })
            return
        }

        // DI-005: Use atomic JSONB merge to avoid read-modify-write race.
        // Two concurrent PATCHes no longer lose the first write — Postgres
        // `settings || $patch` is a single atomic UPDATE with no read step.
        if (settings !== undefined) {
            // Atomic JSONB merge — avoids the read-modify-write race entirely.
            await workspacesRepo.patchWithSettingsMerge(id, name, settings)
        } else {
            // Name-only update — no race concern
            await workspacesRepo.update(id, name ? { name } : {})
        }

        // Verify workspace exists (the UPDATE silently succeeds on zero rows)
        if (!await workspacesRepo.exists(id)) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, id }, '[workspaces.update] failed to update workspace')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update workspace' } })
    }
})


// GET /api/workspaces/:id/export — DI-009: JSON export of workspace data
workspacesRouter.get('/:id/export', async (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, id)) return
    if (req.workspaceRole && !['owner', 'admin'].includes(req.workspaceRole)) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only workspace owners/admins can export data' } })
        return
    }

    try {
        const ws = await workspacesRepo.getForExport(id)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        // Strip sensitive fields from settings
        const { aiProviders: _omit, ...safeSettings } = (ws.settings ?? {}) as Record<string, unknown>

        const [convos, taskRows, memoryRows, ruleRows] = await workspacesRepo.loadExportChildren(id)

        const exportData = {
            exportedAt: new Date().toISOString(),
            workspace: { ...ws, settings: safeSettings },
            conversations: convos,
            tasks: taskRows,
            memories: memoryRows,
            behaviorRules: ruleRows,
        }

        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Disposition', `attachment; filename="plexo-export-${ws.name.replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().slice(0, 10)}.json"`)
        res.json(exportData)

        trackEvent('workspace.exported', 'info', { workspaceId: id, userId: req.user?.id })
    } catch (err) {
        logger.error({ err, workspaceId: id }, 'Failed to export workspace data')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to export workspace data' } })
    }
})
