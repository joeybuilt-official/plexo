// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace App Connections API
 *
 * GET    /api/v1/workspaces/:id/apps           — List apps connected to a workspace
 * POST   /api/v1/workspaces/:id/apps           — Connect an app profile to a workspace
 * DELETE /api/v1/workspaces/:id/apps/:appId    — Disconnect an app from a workspace
 *
 * GET    /api/v1/workspaces/:id/apps/:appId/authorizations     — List user authorizations
 * POST   /api/v1/workspaces/:id/apps/:appId/authorizations     — Grant user authorization
 * DELETE /api/v1/workspaces/:id/apps/:appId/authorizations/:userId — Revoke user authorization
 */

import { Router, type Router as RouterType } from 'express'
import { z } from 'zod'
import * as workspaceAppsRepo from '../repositories/workspace-apps.repository.js'
import { logger } from '../logger.js'
import { requireAuth } from '../middleware/auth.js'
import { UUID_RE } from '../validation.js'

export const workspaceAppsRouter: RouterType = Router({ mergeParams: true })

// All workspace-app routes require auth
workspaceAppsRouter.use(requireAuth)

function workspaceGuard(req: import('express').Request, res: import('express').Response): string | null {
    const id = (req.params as { id: string }).id
    if (!id || !UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'workspace id must be a UUID' } })
        return null
    }
    return id
}

// ── GET / — list apps connected to workspace ─────────────────────────────────

workspaceAppsRouter.get('/', async (req, res) => {
    const workspaceId = workspaceGuard(req, res)
    if (!workspaceId) return

    try {
        // Verify workspace exists
        if (!await workspaceAppsRepo.workspaceExists(workspaceId)) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
        }

        // Return all registered app profiles that have any authorization in this workspace
        const rows = await workspaceAppsRepo.listWorkspaceApps(workspaceId)

        return res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /workspaces/:id/apps failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list workspace apps' } })
    }
})

// ── POST / — connect an app to workspace (grant workspace-level access) ───────

const connectSchema = z.object({
    appId: z.string().min(1),
    userId: z.string().uuid(),
    scopes: z.array(z.string()).default([]),
})

workspaceAppsRouter.post('/', async (req, res) => {
    const workspaceId = workspaceGuard(req, res)
    if (!workspaceId) return

    try {
        const parsed = connectSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { appId, userId, scopes } = parsed.data

        // Verify app profile exists
        if (!await workspaceAppsRepo.appProfileExists(appId)) {
            return res.status(404).json({ error: { code: 'APP_NOT_FOUND', message: 'App profile not registered on this node' } })
        }

        const auth = await workspaceAppsRepo.upsertAuthorization({ userId, appId, workspaceId, scopes })

        logger.info({ event: 'workspace_app_connected', appId, workspaceId }, 'App connected to workspace')
        return res.json({ ok: true, authorization: auth })
    } catch (err) {
        logger.error({ err }, 'POST /workspaces/:id/apps failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to connect app' } })
    }
})

// ── DELETE /:appId — disconnect app from workspace ────────────────────────────

workspaceAppsRouter.delete('/:appId', async (req, res) => {
    const workspaceId = workspaceGuard(req, res)
    if (!workspaceId) return

    const { appId } = req.params as { appId: string }

    try {
        const result = await workspaceAppsRepo.revokeApp(workspaceId, appId)

        if (result.length === 0) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'App not connected to this workspace' } })
        }

        logger.info({ event: 'workspace_app_disconnected', appId, workspaceId }, 'App disconnected from workspace')
        return res.json({ ok: true, revoked: result.length })
    } catch (err) {
        logger.error({ err }, 'DELETE /workspaces/:id/apps/:appId failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to disconnect app' } })
    }
})

// ── GET /:appId/authorizations — list user authorizations for an app ──────────

workspaceAppsRouter.get('/:appId/authorizations', async (req, res) => {
    const workspaceId = workspaceGuard(req, res)
    if (!workspaceId) return

    const { appId } = req.params as { appId: string }

    try {
        const rows = await workspaceAppsRepo.listAuthorizations(workspaceId, appId)

        return res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /workspaces/:id/apps/:appId/authorizations failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list authorizations' } })
    }
})

// ── POST /:appId/authorizations — grant user authorization ───────────────────

const grantSchema = z.object({
    userId: z.string().uuid(),
    scopes: z.array(z.string()).default([]),
})

workspaceAppsRouter.post('/:appId/authorizations', async (req, res) => {
    const workspaceId = workspaceGuard(req, res)
    if (!workspaceId) return

    const { appId } = req.params as { appId: string }

    try {
        const parsed = grantSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { userId, scopes } = parsed.data

        const auth = await workspaceAppsRepo.upsertAuthorization({ userId, appId, workspaceId, scopes })

        return res.json({ ok: true, authorization: auth })
    } catch (err) {
        logger.error({ err }, 'POST /workspaces/:id/apps/:appId/authorizations failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to grant authorization' } })
    }
})

// ── DELETE /:appId/authorizations/:userId — revoke user authorization ─────────

workspaceAppsRouter.delete('/:appId/authorizations/:userId', async (req, res) => {
    const workspaceId = workspaceGuard(req, res)
    if (!workspaceId) return

    const { appId, userId } = req.params as { appId: string; userId: string }
    if (!UUID_RE.test(userId)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'userId must be a UUID' } })
    }

    try {
        const updated = await workspaceAppsRepo.revokeUser(workspaceId, appId, userId)

        if (!updated) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Authorization not found' } })
        }

        return res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'DELETE /workspaces/:id/apps/:appId/authorizations/:userId failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke authorization' } })
    }
})
