// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * UserSelf API (§20)
 *
 * GET   /api/v1/user-self?workspaceId=
 * PATCH /api/v1/user-self
 */
import { Router, type Router as RouterType } from 'express'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import * as userSelfRepo from '../repositories/user-self.repository.js'

export const userSelfRouter: RouterType = Router()

// Get UserSelf for a workspace
userSelfRouter.get('/', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    try {
        const row = await userSelfRepo.getByWorkspace(workspaceId)
        if (!row) {
            res.json({
                identity: {},
                preferences: {},
                relationships: [],
                contexts: {},
                communicationStyle: {},
            })
            return
        }
        res.json(row)
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/user-self failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get UserSelf' } })
    }
})

// Update UserSelf fields (upsert)
userSelfRouter.patch('/', async (req, res) => {
    const { workspaceId, ...fields } = req.body as {
        workspaceId?: string
        identity?: Record<string, unknown>
        preferences?: Record<string, unknown>
        relationships?: string[]
        contexts?: Record<string, unknown>
        communicationStyle?: Record<string, unknown>
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    const updateFields: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.identity !== undefined) updateFields.identity = fields.identity
    if (fields.preferences !== undefined) updateFields.preferences = fields.preferences
    if (fields.relationships !== undefined) updateFields.relationships = fields.relationships
    if (fields.contexts !== undefined) updateFields.contexts = fields.contexts
    if (fields.communicationStyle !== undefined) updateFields.communicationStyle = fields.communicationStyle

    try {
        const row = await userSelfRepo.upsert(workspaceId, updateFields)
        res.json(row)
    } catch (err) {
        logger.error({ err }, 'PATCH /api/v1/user-self failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update UserSelf' } })
    }
})
