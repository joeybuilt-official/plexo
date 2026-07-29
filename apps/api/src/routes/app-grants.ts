// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Operator App-Grant API — Connection & Profile Standard (ADR 0001 §3).
 *
 * GET /api/v1/app-grants/:workspaceId            — list per-app grants for a workspace
 * PUT /api/v1/app-grants/:workspaceId/:appId     — set/widen a grant (operator only)
 *
 * Grants are DEFAULT-DENY: an app gets nothing in a workspace until the operator
 * creates a 'granted' row here. Mutations require a real operator session (a
 * member with admin/owner role); app service-key callers cannot grant themselves
 * scope — that would defeat default-deny.
 */
import { Router, type Router as RouterType } from 'express'
import { z } from 'zod'
import * as appGrantsRepo from '../repositories/app-grants.repository.js'
import { logger } from '../logger.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'

export const appGrantsRouter: RouterType = Router()

const grantSchema = z.object({
    allowedConnectors: z.array(z.string()).default([]),
    capabilities: z.array(z.string()).default([]),
    status: z.enum(['granted', 'pending', 'revoked']).default('granted'),
})

// ── GET /:workspaceId — list grants ──────────────────────────────────────────

appGrantsRouter.get('/:workspaceId', async (req, res) => {
    const workspaceId = req.params.workspaceId as string
    if (!(await ensureWorkspaceAccess(req, res, workspaceId))) return
    try {
        const [rows, apps, conns, exts, obs] = await Promise.all([
            appGrantsRepo.listGrants(workspaceId),
            // Registered apps — lets the operator UI offer a picker when creating a
            // grant for an app that has not negotiated yet (no grant row exists).
            appGrantsRepo.listAppProfiles(),
            // The real connector vocabulary in THIS workspace — exactly the
            // registryIds enforcement matches grant.allowedConnectors against.
            appGrantsRepo.listInstalledConnectorRegistryIds(workspaceId),
            // The real capability vocabulary — manifest.capabilities of the enabled
            // extensions; enforcement (loadPluginTools) checks these exact tokens
            // against grant.capabilities, so suggesting them keeps grants correct.
            appGrantsRepo.listEnabledExtensionManifests(workspaceId),
            // Monitor-mode observations — what enforcement WOULD have excluded per
            // app in this workspace (ADR 0001 §3 rollout). Lets the operator seed
            // grants from real coverage gaps before switching to enforce.
            appGrantsRepo.listMonitorObservations(workspaceId),
        ])

        const availableConnectors = [...new Set(conns.map((c) => c.registryId).filter(Boolean))].sort()
        const availableCapabilities = [...new Set(
            exts.flatMap((e) => {
                const caps = (e.manifest as { capabilities?: unknown } | null)?.capabilities
                return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === 'string') : []
            }),
        )].sort()

        return res.json({ items: rows, total: rows.length, apps, availableConnectors, availableCapabilities, observations: obs })
    } catch (err) {
        logger.error({ err, workspaceId }, 'GET /app-grants failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list grants' } })
    }
})

// ── PUT /:workspaceId/:appId — set/widen a grant (operator only) ──────────────

appGrantsRouter.put('/:workspaceId/:appId', async (req, res) => {
    const workspaceId = req.params.workspaceId as string
    const appId = req.params.appId as string
    if (!(await ensureWorkspaceAccess(req, res, workspaceId))) return

    // Operator-only: a real authenticated user with an elevated role. App
    // service-key callers (no req.user) are rejected so an app cannot widen its
    // own grant.
    if (!req.user?.id) {
        return res.status(403).json({ error: { code: 'OPERATOR_ONLY', message: 'Grant changes require an operator session' } })
    }
    if (req.workspaceRole !== 'admin' && req.workspaceRole !== 'owner') {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin or owner role required to change grants' } })
    }

    const parsed = grantSchema.safeParse(req.body)
    if (!parsed.success) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        })
    }
    const { allowedConnectors, capabilities, status } = parsed.data

    try {
        await appGrantsRepo.upsertGrant({ appId, workspaceId, allowedConnectors, capabilities, status, grantedBy: req.user.id })
        logger.info({ event: 'app_grant_set', workspaceId, appId, status, by: req.user.id }, 'App grant updated')
        return res.json({ ok: true, appId, workspaceId, status, allowedConnectors, capabilities })
    } catch (err) {
        logger.error({ err, workspaceId, appId }, 'PUT /app-grants failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to set grant' } })
    }
})
