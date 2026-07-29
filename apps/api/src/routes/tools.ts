// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tools API — Works Phase 5.
 *
 * POST /api/v1/tools/invoke  { workspaceId, toolName, args? }
 *
 * Thin wrapper that verifies an installed extension exposes the named
 * tool and hands off to the extension runtime. Phase 5 scope is just
 * the dispatcher plumbing — the agent-loop already has full tool
 * invocation logic, but the UI needs a direct endpoint for "run this
 * tool now" buttons surfaced on instruction/config works.
 *
 * If no matching installed extension is found, we return a structured
 * 404 so the UI can prompt the user to install it.
 */

import { Router, type Router as RouterType } from 'express'
import * as toolsRepo from '../repositories/tools.repository.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'

export const toolsRouter: RouterType = Router()

toolsRouter.post('/invoke', async (req, res) => {
    const { workspaceId, toolName, args } = req.body as {
        workspaceId?: string
        toolName?: string
        args?: Record<string, unknown>
    }
    if (!req.user?.id) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Auth required' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!toolName || typeof toolName !== 'string' || toolName.length > 200) {
        res.status(400).json({ error: { code: 'MISSING_TOOL', message: 'toolName required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        // Find an installed, enabled extension whose manifest declares this
        // tool. The extension name or one of its declared tools must match.
        const ext = await toolsRepo.findInstalledByName(workspaceId, toolName)

        if (!ext) {
            res.status(404).json({
                error: {
                    code: 'TOOL_NOT_INSTALLED',
                    message: `No installed extension named "${toolName}" in this workspace.`,
                    hint: 'Install it from the Hub or Marketplace first.',
                },
            })
            return
        }
        if (!ext.enabled) {
            res.status(409).json({
                error: {
                    code: 'TOOL_DISABLED',
                    message: `Extension "${toolName}" is installed but disabled. Enable it in Settings > Extensions.`,
                },
            })
            return
        }

        // Phase 5 — acknowledge dispatch. Full in-process invocation lives
        // in the agent-loop; a synchronous "run this tool from the UI"
        // path will layer on top in Phase 5.1 once we decide whether to
        // execute on the web thread or push to the queue. For now we
        // return an acknowledgement so the UI can surface "Dispatched".
        logger.info({ workspaceId, toolName, userId: req.user.id }, 'tool.invoke dispatched')
        res.status(202).json({
            dispatched: true,
            extensionId: ext.id,
            toolName,
            args: args ?? {},
            message: 'Tool invocation dispatched. Watch the active task for output.',
        })
    } catch (err) {
        logger.error({ err }, 'POST /tools/invoke failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to invoke tool' } })
    }
})
