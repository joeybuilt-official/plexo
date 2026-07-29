// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import * as workspacesRepo from '../repositories/workspaces.repository.js'
import { push } from '@plexo/queue'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { loadGrantedProfile, getEnforcementMode } from '@plexo/agent/profile/grant'

export const agentsRunRouter: RouterType = Router()

// ── POST /api/v1/agents/run ──────────────────────────────────────────────────
// Levio's agent dispatcher calls this endpoint to enqueue an agent_dispatch
// task in the Plexo queue on behalf of a user.
//
// Auth:    requireAuth middleware (applied at v1 router level) handles service
//          key validation via tryAppServiceKeyAuth before this handler runs.
// Headers: X-User-Id (UUID) — the user whose workspace should be targeted
// Body:    { agentId: string, context?: Record<string, unknown> }
// Returns: { taskId, workspaceId, status: 'queued' }

agentsRunRouter.post('/run', async (req, res) => {
    const userId = req.headers['x-user-id'] as string | undefined
    const { agentId, context = {} } = req.body as {
        agentId?: string
        context?: Record<string, unknown>
    }

    if (!userId) {
        res.status(400).json({ error: { code: 'MISSING_USER_ID', message: 'X-User-Id header is required' } })
        return
    }
    if (!UUID_RE.test(userId)) {
        res.status(400).json({ error: { code: 'INVALID_USER_ID', message: 'X-User-Id must be a valid UUID' } })
        return
    }
    if (!agentId || typeof agentId !== 'string') {
        res.status(400).json({ error: { code: 'MISSING_AGENT_ID', message: 'agentId is required' } })
        return
    }
    if (context !== null && typeof context !== 'object' || Array.isArray(context)) {
        res.status(400).json({ error: { code: 'INVALID_CONTEXT', message: 'context must be an object' } })
        return
    }

    try {
        // Resolve the workspace owned by this user
        const workspace = await workspacesRepo.getIdByOwner(userId)

        if (!workspace) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'No workspace found for this user' } })
            return
        }

        // Cross-tenant binding (arch-findings P1): the service key authenticates the
        // *app*, but X-User-Id (→ target workspace) is fully caller-controlled. Bind
        // the dispatch to the operator-managed app→workspace grant so an app can only
        // dispatch into workspaces it's been granted. Rollout-safe via the same gate
        // as the rest of the profile system: under 'enforce' an ungranted dispatch is
        // rejected; under 'monitor'/'off' it's logged (visibility) but allowed, so
        // nothing breaks before grants are seeded. The IDOR closes operationally when
        // PROFILE_ENFORCEMENT_MODE=enforce + grants exist.
        const callerAppId = req.serviceContext?.appId
        if (callerAppId) {
            const grant = await loadGrantedProfile(workspace.id, callerAppId)
            if (!grant) {
                const mode = getEnforcementMode()
                if (mode === 'enforce') {
                    logger.warn({ appId: callerAppId, workspaceId: workspace.id, userId }, 'Agent dispatch denied — app not granted for target workspace')
                    res.status(403).json({ error: { code: 'APP_NOT_GRANTED', message: 'This app is not granted access to the target workspace' } })
                    return
                }
                logger.warn({ appId: callerAppId, workspaceId: workspace.id, userId, mode }, 'Agent dispatch into ungranted workspace (allowed — enforcement not in enforce mode)')
            }
        }

        const taskId = await push({
            workspaceId: workspace.id,
            type: 'automation',
            source: 'extension',
            context: {
                agentId,
                ...context,
                // Connection & Profile Standard (ADR 0001 §3): stamp the dispatching
                // app's identity from the service-key context for per-(app×workspace)
                // capability enforcement. Placed after the spread so a client-supplied
                // context.appId can never spoof it. Absent only when no service key.
                ...(req.serviceContext?.appId ? { appId: req.serviceContext.appId } : {}),
            },
        })

        logger.info({ taskId, workspaceId: workspace.id, agentId, userId }, 'Agent dispatch queued')

        res.status(201).json({ taskId, workspaceId: workspace.id, status: 'queued' })
    } catch (err) {
        logger.error({ err, agentId, userId }, 'POST /api/v1/agents/run failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to enqueue agent dispatch' } })
    }
})
