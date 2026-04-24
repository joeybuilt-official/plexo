// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Vision capability status endpoint.
 *
 * GET /api/v1/vision/status?workspaceId=...
 *   Returns whether the workspace has any vision-capable model available.
 *   Used by the IntegrationsNudgeModal and Telegram adapter to prompt users
 *   to set up a free vision provider (like Groq) if none exists.
 */

import { Router, type Router as RouterType } from 'express'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { findVisionCapableModel, modelSupportsVision } from '@plexo/agent/providers/vision'
import { PROVIDER_DEFAULT_MODELS } from '@plexo/agent/providers/registry'
import { logger } from '../logger.js'

export const visionRouter: RouterType = Router()

visionRouter.get('/status', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (!aiSettings) {
            res.json({ configured: false, reason: 'no_providers' })
            return
        }

        // Check if primary model has vision
        const primaryKey = aiSettings.primaryProvider
        const primaryConfig = aiSettings.providers[primaryKey]
        const primaryModel = primaryConfig?.model ?? PROVIDER_DEFAULT_MODELS[primaryKey] ?? ''
        const primaryHasVision = modelSupportsVision(primaryModel, primaryKey)

        if (primaryHasVision) {
            res.json({ configured: true, provider: primaryKey, model: primaryModel, isPrimary: true })
            return
        }

        // Check fallback chain
        const fallback = findVisionCapableModel(aiSettings, PROVIDER_DEFAULT_MODELS, primaryKey)
        if (fallback) {
            res.json({ configured: true, provider: fallback.providerKey, model: fallback.modelId, isPrimary: false })
            return
        }

        res.json({ configured: false, reason: 'no_vision_model' })
    } catch (err) {
        logger.error({ err, workspaceId }, 'GET vision/status failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to check vision status' } })
    }
})
