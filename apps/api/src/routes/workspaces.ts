// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, eq, desc } from '@plexo/db'
import { workspaces } from '@plexo/db'
import { captureLifecycleEvent } from '../sentry.js'

export const workspacesRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/workspaces — list workspaces, optionally filter by ownerId
workspacesRouter.get('/', async (req, res) => {
    const { ownerId } = req.query as Record<string, string>

    if (ownerId && !UUID_RE.test(ownerId)) {
        res.status(400).json({ error: { code: 'INVALID_OWNER', message: 'Valid UUID required for ownerId' } })
        return
    }

    try {
        const query = db
            .select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId, createdAt: workspaces.createdAt })
            .from(workspaces)

        const rows = await (ownerId
            ? query.where(eq(workspaces.ownerId, ownerId)).orderBy(desc(workspaces.createdAt)).limit(10)
            : query.orderBy(desc(workspaces.createdAt)).limit(50)
        )

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

// POST /api/workspaces — create a new workspace
workspacesRouter.post('/', async (req, res) => {
    const { name, ownerId } = req.body as { name?: string; ownerId?: string }
    if (!name?.trim() || !ownerId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'name and ownerId are required' } })
        return
    }
    if (!UUID_RE.test(ownerId)) {
        res.status(400).json({ error: { code: 'INVALID_OWNER', message: 'Valid UUID required for ownerId' } })
        return
    }
    if (name.trim().length > 200) {
        res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name max 200 chars' } })
        return
    }
    try {
        const [created] = await db.insert(workspaces)
            .values({ name: name.trim(), ownerId, settings: {} })
            .returning({ id: workspaces.id, name: workspaces.name })
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
    try {
        // Guard: refuse to delete the last remaining workspace
        const all = await db.select({ id: workspaces.id }).from(workspaces)
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

        await db.delete(workspaces).where(eq(workspaces.id, id))
        captureLifecycleEvent('workspace.deleted', 'warning', { workspaceId: id })
        res.json({ ok: true })
    } catch (err) {
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete workspace' } })
    }
})

// PATCH /api/workspaces/:id — update name and/or settings (deep-merges settings)
workspacesRouter.patch('/:id', async (req, res) => {
    const { id } = req.params
    const { name, settings } = req.body as { name?: string; settings?: Record<string, unknown> }

    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (name && name.length > 200) {
        res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name max 200 chars' } })
        return
    }

    try {
        if (!name && settings === undefined) {
            res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'name or settings required' } })
            return
        }

        // Read current settings so we can deep-merge instead of overwrite
        const [current] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, id))
            .limit(1)

        if (!current) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const merged = settings !== undefined
            ? { ...(current.settings as Record<string, unknown> ?? {}), ...settings }
            : undefined

        const update: Record<string, unknown> = {}
        if (name) update.name = name
        if (merged !== undefined) update.settings = merged

        await db.update(workspaces).set(update).where(eq(workspaces.id, id))
        res.json({ ok: true })
    } catch (err) {
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update workspace' } })
    }
})
