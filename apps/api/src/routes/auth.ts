// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { z } from 'zod'
import { db, eq, sql } from '@plexo/db'
import { users, workspaces, workspaceMembers } from '@plexo/db'
import { logger } from '../logger.js'
import { captureLifecycleEvent } from '../sentry.js'
import { UUID_RE } from '../validation.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'

export const authRouter: RouterType = Router()

// GET /api/auth/setup-status — returns whether initial setup is needed
// Now checks if any workspace exists (users are managed by Supabase)
authRouter.get('/setup-status', async (_req, res) => {
    const rows = await db.select({ count: sql<number>`count(*)` }).from(workspaces)
    const needsSetup = Number(rows[0]?.count || 0) === 0
    res.json({ needsSetup })
})

// POST /api/auth/workspace/ensure — service-to-service: get-or-create workspace for a user.
// Used by Joeybuilt apps (Levio, Fylo, etc.) to ensure a Plexo workspace exists for a user
// before initiating OAuth flows. Requires PLEXO_SERVICE_KEY auth.
authRouter.post('/workspace/ensure', requireServiceKey, async (req, res) => {
    const { userId, name: wsName } = req.body as { userId?: string; name?: string }

    if (!userId || !UUID_RE.test(userId)) {
        res.status(400).json({ error: { code: 'INVALID_USER_ID', message: 'Valid userId UUID required' } })
        return
    }

    try {
        // Check for existing workspace owned by this user
        const [existing] = await db.select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.ownerId, userId))
            .limit(1)

        if (existing) {
            res.json({ workspaceId: existing.id, name: existing.name, created: false })
            return
        }

        // Create a new personal workspace
        const displayName = (wsName?.trim() ?? 'My Workspace').slice(0, 200) || 'My Workspace'
        const [ws] = await db.insert(workspaces).values({
            name: displayName,
            ownerId: userId,
            settings: {},
        }).returning({ workspaceId: workspaces.id, name: workspaces.name })

        await db.insert(workspaceMembers).values({
            workspaceId: ws!.workspaceId,
            userId,
            role: 'owner',
        }).onConflictDoNothing()

        captureLifecycleEvent('workspace.created', 'info', { workspaceId: ws!.workspaceId, source: req.serviceContext?.appId })
        logger.info({ userId, name: displayName, appId: req.serviceContext?.appId }, 'Workspace auto-created via service key')
        res.status(201).json({ workspaceId: ws!.workspaceId, name: ws!.name, created: true })
    } catch (err) {
        logger.error({ err }, 'POST /api/auth/workspace/ensure failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to ensure workspace' } })
    }
})

// POST /api/auth/workspace — create a workspace (used by setup wizard)
// Requires Supabase JWT auth (middleware injects req.user)
authRouter.post('/workspace', async (req, res) => {
    const { name, ownerId: bodyOwnerId } = req.body as { name?: string; ownerId?: string }
    if (!name?.trim()) {
        res.status(400).json({ error: { code: 'MISSING_NAME', message: 'name required' } })
        return
    }
    if (name.trim().length > 200) {
        res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name max 200 chars' } })
        return
    }
    if (bodyOwnerId && !UUID_RE.test(bodyOwnerId)) {
        res.status(400).json({ error: { code: 'INVALID_OWNER', message: 'Valid UUID required for ownerId' } })
        return
    }

    try {
        // Resolve owner: explicit body param → authenticated user (from Supabase JWT)
        const resolvedOwnerId = bodyOwnerId
            ?? (req as unknown as { user?: { id: string } }).user?.id

        if (!resolvedOwnerId) {
            res.status(400).json({
                error: { code: 'NO_OWNER', message: 'ownerId required (or authenticate with Supabase JWT)' },
            })
            return
        }

        const [ws] = await db.insert(workspaces).values({
            name: name.trim(),
            ownerId: resolvedOwnerId,
            settings: {},
        }).returning({ workspaceId: workspaces.id })

        // Seed the owner as a member so the Members page shows them immediately
        await db.insert(workspaceMembers).values({
            workspaceId: ws!.workspaceId,
            userId: resolvedOwnerId,
            role: 'owner',
        }).onConflictDoNothing()

        captureLifecycleEvent('workspace.created', 'info', { workspaceId: ws!.workspaceId, name: name.trim() })
        logger.info({ name: name.trim(), ownerId: resolvedOwnerId }, 'Workspace created')
        res.status(201).json({ workspaceId: ws!.workspaceId, name: name.trim() })
    } catch (err) {
        logger.error({ err }, 'POST /api/auth/workspace failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
    }
})
