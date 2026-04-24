// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, eq, sql, inArray } from '@plexo/db'
import { workspaces, workspaceMembers } from '@plexo/db'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { optionalAuth } from '../middleware/auth.js'

export const authRouter: RouterType = Router()

// DELETE /api/auth/account-cleanup — service-to-service: delete all workspaces owned by a user.
// Called by the Better Auth beforeDelete hook when a user account is being removed.
// This is the server-side safety net for DI-002: ensures workspace data is cleaned up
// even if the client-side deletion is bypassed (e.g., direct API call to Better Auth).
authRouter.delete('/account-cleanup', requireServiceKey, async (req, res) => {
    const { userId } = req.body as { userId?: string }
    if (!userId || !UUID_RE.test(userId)) {
        res.status(400).json({ error: { code: 'INVALID_USER_ID', message: 'Valid userId UUID required' } })
        return
    }

    try {
        const owned = await db.select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.ownerId, userId))

        if (owned.length === 0) {
            logger.info({ userId }, 'Account cleanup: no workspaces found for user')
            res.json({ ok: true, deleted: 0 })
            return
        }

        await db.delete(workspaces).where(inArray(workspaces.id, owned.map(w => w.id)))
        for (const ws of owned) {
            trackEvent('workspace.deleted', 'warning', { workspaceId: ws.id, reason: 'account_deletion' })
        }
        const deleted = owned.length

        logger.info({ userId, deleted }, 'Account cleanup: deleted owned workspaces')
        res.json({ ok: true, deleted })
    } catch (err) {
        logger.error({ err, userId }, 'DELETE /api/auth/account-cleanup failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to clean up account data' } })
    }
})

// GET /api/auth/setup-status — returns whether initial setup is needed
// Now checks if any workspace exists (users are managed by Better Auth)
authRouter.get('/setup-status', async (_req, res) => {
    const rows = await db.select({ count: sql<number>`count(*)` }).from(workspaces)
    const needsSetup = Number(rows[0]?.count || 0) === 0
    res.json({ needsSetup })
})

// POST /api/auth/workspace/ensure — service-to-service: get-or-create workspace for a user.
// Used by Joeybuilt apps (Levio, Fylo, etc.) to ensure a Plexo workspace exists for a user
// before initiating OAuth flows. Requires PLEXO_SERVICE_KEY auth.
authRouter.post('/workspace/ensure', requireServiceKey, async (req, res) => {
    const { userId, name: wsName, email: wsEmail } = req.body as { userId?: string; name?: string; email?: string }

    if (!userId || !UUID_RE.test(userId)) {
        res.status(400).json({ error: { code: 'INVALID_USER_ID', message: 'Valid userId UUID required' } })
        return
    }

    try {
        // Users live in auth.user (exposed via postgres_fdw). We don't
        // insert them here — Better Auth owns that table. wsEmail is only used
        // for telemetry / future audit, not persisted.
        void wsEmail

        // Check for existing workspace owned by this user
        const [existing] = await db.select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.ownerId, userId))
            .limit(1)

        if (existing) {
            res.json({ workspaceId: existing.id, name: existing.name, created: false })
            return
        }

        // Create a new personal workspace for this user.
        const displayName = (wsName?.trim() ?? 'My Workspace').slice(0, 200) || 'My Workspace'
        const [ws] = await db.insert(workspaces).values({
            name: displayName,
            ownerId: userId,
            settings: {},
            // Phase 6 — flag for first-run wizard.
            intelligenceSettings: { firstRunPending: true },
        }).returning({ workspaceId: workspaces.id, name: workspaces.name })

        if (!ws) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
            return
        }

        await db.insert(workspaceMembers).values({
            workspaceId: ws.workspaceId,
            userId,
            role: 'owner',
        }).onConflictDoNothing()

        trackEvent('workspace.created', 'info', { workspaceId: ws.workspaceId, source: (req as any).serviceContext?.appId })
        logger.info({ userId, name: displayName, appId: (req as any).serviceContext?.appId }, 'Workspace auto-created via service key')
        res.status(201).json({ workspaceId: ws.workspaceId, name: ws.name, created: true })
    } catch (err) {
        logger.error({ err }, 'POST /api/auth/workspace/ensure failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to ensure workspace' } })
    }
})

// POST /api/auth/workspace — create a workspace (used by setup wizard)
// optionalAuth populates req.user from JWT when present
authRouter.post('/workspace', optionalAuth, async (req, res) => {
    const { name } = req.body as { name?: string; ownerId?: string }

    // SEC-007: Workspace creation requires authentication — owner is always the authenticated user
    if (!req.user) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required to create a workspace' } })
        return
    }

    if (!name?.trim()) {
        res.status(400).json({ error: { code: 'MISSING_NAME', message: 'name required' } })
        return
    }
    if (name.trim().length > 200) {
        res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name max 200 chars' } })
        return
    }

    try {
        // SEC-007: Owner is always the authenticated user — ignore bodyOwnerId entirely
        const resolvedOwnerId = req.user.id

        const [ws] = await db.insert(workspaces).values({
            name: name.trim(),
            ownerId: resolvedOwnerId,
            settings: {},
            // Phase 6 — flag for first-run wizard.
            intelligenceSettings: { firstRunPending: true },
        }).returning({ workspaceId: workspaces.id })

        if (!ws) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
            return
        }

        // Seed the owner as a member so the Members page shows them immediately
        await db.insert(workspaceMembers).values({
            workspaceId: ws.workspaceId,
            userId: resolvedOwnerId,
            role: 'owner',
        }).onConflictDoNothing()

        trackEvent('workspace.created', 'info', { workspaceId: ws.workspaceId, name: name.trim() })

        // Analytics: onboarding started — this route is the setup wizard entry point
        try {
            const { emitOnboardingStarted } = await import('../analytics/events.js')
            emitOnboardingStarted({ source: 'web' })
        } catch { /* analytics must never crash the app */ }

        logger.info({ name: name.trim(), ownerId: resolvedOwnerId }, 'Workspace created')
        res.status(201).json({ workspaceId: ws.workspaceId, name: name.trim() })
    } catch (err) {
        logger.error({ err }, 'POST /api/auth/workspace failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
    }
})
