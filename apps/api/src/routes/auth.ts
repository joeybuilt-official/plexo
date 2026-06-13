// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import * as authRepo from '../repositories/auth.repository.js'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { optionalAuth } from '../middleware/auth.js'
import { mirrorMembershipUpsert } from '../lib/permission-graph.js'

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
        const owned = await authRepo.listOwnedWorkspaceIds(userId)

        if (owned.length === 0) {
            logger.info({ userId }, 'Account cleanup: no workspaces found for user')
            res.json({ ok: true, deleted: 0 })
            return
        }

        await authRepo.deleteWorkspacesByIds(owned.map(w => w.id))
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
    const rows = await authRepo.countWorkspaces()
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
        const existing = await authRepo.getOwnedWorkspaceIdName(userId)

        if (existing) {
            res.json({ workspaceId: existing.id, name: existing.name, created: false })
            return
        }

        // Create a new personal workspace for this user.
        const displayName = (wsName?.trim() ?? 'My Workspace').slice(0, 200) || 'My Workspace'
        const ws = await authRepo.createWorkspaceReturningIdName(displayName, userId)

        if (!ws) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
            return
        }

        await authRepo.insertOwnerMember(ws.workspaceId, userId)
        // Phase C1 (ADR 0022) shadow-write — owner seed on workspace create.
        void mirrorMembershipUpsert({ workspaceId: ws.workspaceId, userId, role: 'owner' })

        trackEvent('workspace.created', 'info', { workspaceId: ws.workspaceId, source: (req as any).serviceContext?.appId })
        logger.info({ userId, name: displayName, appId: (req as any).serviceContext?.appId }, 'Workspace auto-created via service key')
        res.status(201).json({ workspaceId: ws.workspaceId, name: ws.name, created: true })
    } catch (err) {
        logger.error({ err }, 'POST /api/auth/workspace/ensure failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to ensure workspace' } })
    }
})

// ── POST /api/auth/profiles/auto-attach-user ────────────────────────────────
//
// Universal Plexo↔app auto-connect. Joeybuilt apps call this on every
// authenticated request (debounced) to ensure that the calling app is
// "installed" against the user's Plexo workspace WITHOUT any UI step:
//
//   1. Get-or-create the Plexo workspace owned by `userId`.
//   2. Idempotently insert an `installed_connections` row with
//      registry_id = X-App-Id so the agent's connection bridge knows the
//      app is active for this workspace. Bridge resolves user identity at
//      tool-call time via the always-injected `_workspaceOwnerId` setting.
//   3. Idempotently insert a sideloaded `extensions` row for the app's
//      bridge package so PEX exposes the app's tools to the agent.
//
// Idempotent — safe to call on every request. Empty credentials are fine:
// the bridge uses Better Auth user identity (shared across all Joeybuilt
// apps via `pushd.auth.user`) instead of provider tokens.
authRouter.post('/profiles/auto-attach-user', requireServiceKey, async (req, res) => {
    const appId = ((req as any).serviceContext?.appId
        ?? (req.headers['x-app-id'] as string | undefined)
        ?? '').trim().toLowerCase()
    const { userId, name: wsName, email: wsEmail } = req.body as { userId?: string; name?: string; email?: string }

    if (!appId || !/^[a-z][a-z0-9_-]*$/.test(appId)) {
        res.status(400).json({ error: { code: 'INVALID_APP_ID', message: 'X-App-Id header required' } })
        return
    }
    if (!userId || !UUID_RE.test(userId)) {
        res.status(400).json({ error: { code: 'INVALID_USER_ID', message: 'Valid userId UUID required' } })
        return
    }
    void wsEmail

    try {
        // ── Step 1: get-or-create workspace ────────────────────────────
        let workspaceId: string | null = null
        const existing = await authRepo.getOwnedWorkspaceId(userId)

        if (existing) {
            workspaceId = existing.id
        } else {
            const displayName = (wsName?.trim() ?? 'Personal').slice(0, 200) || 'Personal'
            const ws = await authRepo.createWorkspaceReturningId(displayName, userId)
            if (!ws) {
                res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Workspace create failed' } })
                return
            }
            workspaceId = ws.id
            await authRepo.insertOwnerMember(ws.id, userId)
            // Phase C1 (ADR 0022) shadow-write — auto-attach owner seed.
            void mirrorMembershipUpsert({ workspaceId: ws.id, userId, role: 'owner' })
            trackEvent('workspace.created', 'info', { workspaceId: ws.id, source: appId, reason: 'auto-attach' })
            logger.info({ userId, workspaceId: ws.id, appId }, 'Workspace auto-created via profiles/auto-attach-user')
        }

        // ── Step 2: ensure connections_registry row exists for this app ──
        // Fallback for fresh installs where 0098_joeybuilt_apps_auto_connect
        // hasn't run yet, or for apps registered after the migration.
        const profile = await authRepo.getAppProfileDisplayName(appId)

        if (!profile) {
            res.status(404).json({ error: { code: 'APP_NOT_REGISTERED', message: `App "${appId}" must call /api/v1/profiles/register first` } })
            return
        }

        const registryRow = await authRepo.getConnectionsRegistryRow(appId)

        if (!registryRow) {
            // Insert a minimal connections_registry row so the FK on
            // installed_connections is satisfied. Auth type is 'none' —
            // the bridge uses _workspaceOwnerId for identity.
            await authRepo.insertConnectionsRegistryRow(appId, profile.displayName)
        }

        // ── Step 3: idempotent insert of installed_connections row ───────
        let installedCreated = false
        try {
            const insertResult = await authRepo.insertInstalledConnection(workspaceId, appId, profile.displayName)
            installedCreated = insertResult.length > 0
        } catch (err) {
            logger.warn({ err, workspaceId, appId }, 'installed_connections insert raced — non-fatal')
        }

        // ── Step 4: idempotent enable of bridge extension ────────────────
        // Bridge package convention: @joeybuilt/<appId>-bridge.
        // The bridge file exists when the corresponding extensions/core/
        // directory has been deployed alongside plexo-api. We probe the
        // expected on-disk path; if missing, we skip enabling.
        const bridgeName = `@joeybuilt/${appId}-bridge`
        const bridgeEntry = `/app/extensions/core/${appId}-bridge/dist/index.js`
        let bridgeEnabled = false

        const existingBridge = await authRepo.getBridgeExtension(workspaceId, bridgeName)

        if (existingBridge) {
            if (!existingBridge.enabled) {
                await authRepo.enableBridgeExtension(existingBridge.id)
            }
            bridgeEnabled = true
        } else {
            // Insert a minimal bridge extension row. The actual sandbox load
            // happens lazily — if the dist file is missing, the executor
            // logs a warning and proceeds without these tools (no crash).
            try {
                await authRepo.insertBridgeExtension({
                    workspaceId,
                    bridgeName,
                    bridgeEntry,
                    displayName: profile.displayName,
                })
                bridgeEnabled = true
            } catch (err) {
                logger.warn({ err, workspaceId, appId }, 'bridge extension insert failed — degrading without bridge')
            }
        }

        return res.json({
            ok: true,
            workspaceId,
            appId,
            installedConnection: installedCreated || true,
            bridgeExtension: bridgeEnabled,
        })
    } catch (err) {
        logger.error({ err, appId, userId }, 'POST /api/auth/profiles/auto-attach-user failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'auto-attach failed' } })
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

        const ws = await authRepo.createWorkspaceReturningWorkspaceId(name.trim(), resolvedOwnerId)

        if (!ws) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
            return
        }

        // Seed the owner as a member so the Members page shows them immediately
        await authRepo.insertOwnerMember(ws.workspaceId, resolvedOwnerId)
        // Phase C1 (ADR 0022) shadow-write — setup-wizard owner seed.
        void mirrorMembershipUpsert({ workspaceId: ws.workspaceId, userId: resolvedOwnerId, role: 'owner' })

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
