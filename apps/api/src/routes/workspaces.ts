// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, eq, desc, and, inArray, sql } from '@plexo/db'
import { workspaces, workspaceMembers, tasks, conversations, memoryEntries, behaviorRules, DEFAULT_INTELLIGENCE_SETTINGS, DEFAULT_WORKSPACE_SETTINGS } from '@plexo/db'
import { mirrorAuthUserToPublic, type AuthUserPayload } from '@plexo/db/auth/config'
import { trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { mirrorMembershipUpsert } from '../lib/permission-graph.js'
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
        const memberships = isSuperAdmin
            ? null
            : await db
                .select({ workspaceId: workspaceMembers.workspaceId })
                .from(workspaceMembers)
                .where(eq(workspaceMembers.userId, req.user.id))

        const memberWorkspaceIds = memberships?.map((m) => m.workspaceId) ?? []

        if (!isSuperAdmin && memberWorkspaceIds.length === 0) {
            res.json({ items: [], total: 0 })
            return
        }

        const baseQuery = db
            .select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId, createdAt: workspaces.createdAt })
            .from(workspaces)

        const rows = isSuperAdmin
            ? await baseQuery.orderBy(desc(workspaces.createdAt)).limit(50)
            : await baseQuery
                .where(inArray(workspaces.id, memberWorkspaceIds))
                .orderBy(desc(workspaces.createdAt))
                .limit(50)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
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
        const [ws] = await db
            .select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId, settings: workspaces.settings, createdAt: workspaces.createdAt })
            .from(workspaces)
            .where(eq(workspaces.id, id))
            .limit(1)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }
        // Strip aiProviders from settings — credentials are only served (redacted) via
        // GET /api/workspaces/:id/ai-providers to prevent plaintext key exposure.
        const { aiProviders: _omitted, ...safeSettings } = (ws.settings ?? {}) as Record<string, unknown>
        res.json({ ...ws, settings: safeSettings })
    } catch (err) {
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
        const created = await db.transaction(async (tx) => {
            // Backstop for the Better Auth post-commit hook (see ADR 0001).
            // ON CONFLICT no-ops if the hook already mirrored. Skipped when a
            // super-admin acts on behalf of a user whose auth payload we can't
            // load via getSession.
            if (ownerMirror) {
                await mirrorAuthUserToPublic(ownerMirror, tx)
            }

            const [ws] = await tx.insert(workspaces)
                .values({
                    name: name.trim(),
                    ownerId,
                    settings: DEFAULT_WORKSPACE_SETTINGS,
                    // Phase 6 — flag for first-run wizard. The dashboard
                    // banner reads this and walks the user through setup.
                    intelligenceSettings: DEFAULT_INTELLIGENCE_SETTINGS,
                })
                .returning({ id: workspaces.id, name: workspaces.name })

            if (!ws) return null

            // Auto-enroll the owner as a workspace member (role = owner) so
            // subsequent workspace-scoped calls pass the membership check.
            await tx.insert(workspaceMembers).values({
                workspaceId: ws.id,
                userId: ownerId,
                role: 'owner',
            }).onConflictDoNothing()
            // Phase C1 (ADR 0022) shadow-write — owner seed on POST /workspaces.
            void mirrorMembershipUpsert({ workspaceId: ws.id, userId: ownerId, role: 'owner' })

            return ws
        })

        if (!created) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
            return
        }

        res.status(201).json(created)
    } catch (err) {
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
        const all = await db.select({ id: workspaces.id }).from(workspaces).limit(2)
        if (all.length <= 1) {
            res.status(409).json({ error: { code: 'LAST_WORKSPACE', message: 'Cannot delete the last workspace' } })
            return
        }

        const [existing] = await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, id))
            .limit(1)

        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        // Cancel any running tasks before deleting workspace — prevents ghost executors
        const runningTasks = await db.select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.workspaceId, id), inArray(tasks.status, ['running', 'claimed'] as any[])))
            .limit(1000)
        for (const t of runningTasks) {
            cancelActiveTask(t.id)
        }

        // FUN-009: Clean up S3 objects before DB cascade
        // Delete memory attachments (keyed by workspace ID)
        await deleteByPrefix(`memory/${id}/`).catch(err => logger.warn({ err }, 'S3 memory cleanup failed'))
        // Delete task assets (keyed by task ID — collect all task IDs for this workspace)
        const allTasks = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workspaceId, id)).limit(10000)
        await Promise.allSettled(
            allTasks.map(t => deleteByPrefix(`tasks/${t.id}/`).catch(err => logger.warn({ err, taskId: t.id }, 'S3 task cleanup failed')))
        )

        await db.delete(workspaces).where(eq(workspaces.id, id))
        trackEvent('workspace.deleted', 'warning', { workspaceId: id })
        res.json({ ok: true })
    } catch (err) {
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
        const update: Record<string, unknown> = {}
        if (name) update.name = name

        if (settings !== undefined) {
            // Atomic JSONB merge — avoids the read-modify-write race entirely.
            // `settings || $patch::jsonb` merges top-level keys in a single UPDATE.
            await db.update(workspaces)
                .set({
                    ...(name ? { name } : {}),
                    settings: sql`COALESCE(settings, '{}'::jsonb) || ${JSON.stringify(settings)}::jsonb`,
                })
                .where(eq(workspaces.id, id))
        } else {
            // Name-only update — no race concern
            await db.update(workspaces).set(update).where(eq(workspaces.id, id))
        }

        // Verify workspace exists (the UPDATE silently succeeds on zero rows)
        const [exists] = await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, id))
            .limit(1)
        if (!exists) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        res.json({ ok: true })
    } catch (err) {
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
        const [ws] = await db
            .select({ id: workspaces.id, name: workspaces.name, settings: workspaces.settings, createdAt: workspaces.createdAt })
            .from(workspaces)
            .where(eq(workspaces.id, id))
            .limit(1)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        // Strip sensitive fields from settings
        const { aiProviders: _omit, ...safeSettings } = (ws.settings ?? {}) as Record<string, unknown>

        const [convos, taskRows, memoryRows, ruleRows] = await Promise.all([
            db.select()
                .from(conversations)
                .where(eq(conversations.workspaceId, id))
                .orderBy(desc(conversations.createdAt))
                .limit(10000),
            db.select()
                .from(tasks)
                .where(eq(tasks.workspaceId, id))
                .orderBy(desc(tasks.createdAt))
                .limit(10000),
            db.select()
                .from(memoryEntries)
                .where(eq(memoryEntries.workspaceId, id))
                .limit(10000),
            db.select()
                .from(behaviorRules)
                .where(eq(behaviorRules.workspaceId, id))
                .limit(10000),
        ])

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
