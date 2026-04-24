// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workbench API — Works Phase 7.
 *
 * GET    /api/v1/workbench/pins?workspaceId=
 * POST   /api/v1/workbench/pins      { workspaceId, workId }
 * DELETE /api/v1/workbench/pins/:id
 * PATCH  /api/v1/workbench/pins/:id  { position }
 *
 * Pins are scoped to (userId, workId). Workspace is stored for tenant
 * filtering and cascade cleanup on workspace delete.
 */

import { Router, type Router as RouterType } from 'express'
import { db, eq, and, asc, desc } from '@plexo/db'
import { workbenchPins, artifacts, artifactVersions } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'

export const workbenchRouter: RouterType = Router()

// ── GET /api/v1/workbench/pins?workspaceId= ─────────────────────────────
// Lists the current user's pinned works for a workspace, with the live
// current-version content inlined so the workbench pane can render
// without a second round trip.
workbenchRouter.get('/pins', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!req.user?.id) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Auth required' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const rows = await db.select({
            pinId:         workbenchPins.id,
            position:      workbenchPins.position,
            pinnedAt:      workbenchPins.pinnedAt,
            workId:        workbenchPins.workId,
            filename:      artifacts.filename,
            kind:          artifacts.kind,
            type:          artifacts.type,
            meta:          artifacts.meta,
            currentVersion:artifacts.currentVersion,
            updatedAt:     artifacts.updatedAt,
            content:       artifactVersions.content,
        })
        .from(workbenchPins)
        .innerJoin(artifacts, eq(artifacts.id, workbenchPins.workId))
        .innerJoin(artifactVersions, and(
            eq(artifactVersions.artifactId, artifacts.id),
            eq(artifactVersions.version, artifacts.currentVersion),
        ))
        .where(and(
            eq(workbenchPins.userId, req.user.id),
            eq(workbenchPins.workspaceId, workspaceId),
        ))
        .orderBy(asc(workbenchPins.position), desc(workbenchPins.pinnedAt))

        res.json({
            items: rows.map(r => ({
                pinId:    r.pinId,
                position: r.position,
                pinnedAt: r.pinnedAt,
                work: {
                    artifactId: r.workId,
                    filename:   r.filename,
                    kind:       r.kind,
                    type:       r.type,
                    meta:       (r.meta as Record<string, unknown> | null) ?? {},
                    version:    r.currentVersion,
                    updatedAt:  r.updatedAt,
                    content:    r.content,
                    bytes:      Buffer.byteLength(r.content || ''),
                    isText:     true,
                },
            })),
        })
    } catch (err) {
        logger.error({ err }, 'GET /workbench/pins failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list pins' } })
    }
})

// ── POST /api/v1/workbench/pins ─────────────────────────────────────────
// Pin a work. Idempotent on (userId, workId). Returns the row.
workbenchRouter.post('/pins', async (req, res) => {
    const { workspaceId, workId } = req.body as {
        workspaceId?: string
        workId?: string
    }
    if (!req.user?.id) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Auth required' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!workId || workId.length > 64) {
        res.status(400).json({ error: { code: 'MISSING_WORK', message: 'workId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        // Verify the work exists AND belongs to this workspace (prevent
        // cross-workspace pin attacks).
        const [art] = await db.select({ id: artifacts.id, workspaceId: artifacts.workspaceId })
            .from(artifacts)
            .where(eq(artifacts.id, workId))
            .limit(1)

        if (!art) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Work not found' } })
            return
        }
        if (art.workspaceId !== workspaceId) {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Work belongs to a different workspace' } })
            return
        }

        // Upsert on unique (user_id, work_id)
        const [row] = await db.insert(workbenchPins)
            .values({
                userId:      req.user.id,
                workspaceId,
                workId,
                position:    0,
            })
            .onConflictDoNothing()
            .returning()

        // If conflict-do-nothing returned nothing, fetch the existing pin.
        if (!row) {
            const [existing] = await db.select()
                .from(workbenchPins)
                .where(and(
                    eq(workbenchPins.userId, req.user.id),
                    eq(workbenchPins.workId, workId),
                ))
                .limit(1)
            res.status(200).json(existing ?? null)
            return
        }
        res.status(201).json(row)
    } catch (err) {
        logger.error({ err }, 'POST /workbench/pins failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to pin work' } })
    }
})

// ── DELETE /api/v1/workbench/pins/:id ───────────────────────────────────
workbenchRouter.delete('/pins/:id', async (req, res) => {
    const { id } = req.params
    if (!req.user?.id) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Auth required' } })
        return
    }
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    try {
        const deleted = await db.delete(workbenchPins)
            .where(and(
                eq(workbenchPins.id, id),
                eq(workbenchPins.userId, req.user.id),
            ))
            .returning({ id: workbenchPins.id })
        if (deleted.length === 0) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pin not found' } })
            return
        }
        res.status(204).end()
    } catch (err) {
        logger.error({ err }, 'DELETE /workbench/pins/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to unpin' } })
    }
})

// ── PATCH /api/v1/workbench/pins/:id ────────────────────────────────────
// Update the position (for drag-reorder later — scaffolded now).
workbenchRouter.patch('/pins/:id', async (req, res) => {
    const { id } = req.params
    const { position } = req.body as { position?: number }
    if (!req.user?.id) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Auth required' } })
        return
    }
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (typeof position !== 'number' || position < 0 || position > 1000) {
        res.status(400).json({ error: { code: 'INVALID_POSITION', message: 'position must be 0..1000' } })
        return
    }
    try {
        const [row] = await db.update(workbenchPins)
            .set({ position })
            .where(and(
                eq(workbenchPins.id, id),
                eq(workbenchPins.userId, req.user.id),
            ))
            .returning()
        if (!row) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pin not found' } })
            return
        }
        res.json(row)
    } catch (err) {
        logger.error({ err }, 'PATCH /workbench/pins/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update pin' } })
    }
})
